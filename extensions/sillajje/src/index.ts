import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
	createLocalBashOperations,
	type ExtensionAPI,
	type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { loadSillajjeConfig, type SillajjeConfig } from "./config.js";
import { createDebugLogger } from "./debug-log.js";
import {
	buildCommitBody,
	buildMetadata,
	deriveSubject,
	type MetadataFieldToggles,
	smartWrap,
} from "./metadata.js";
import { redirect } from "./path-redirect.js";
import { parseRebaseFoldArgs } from "./rebase-fold.js";
import { SessionState } from "./state.js";
import { formatPill } from "./status-pill.js";
import {
	createSpawnFn,
	generateHeader,
	generateManualHeader,
	generateTrace,
	type SpawnFn,
} from "./sub-generator.js";
import {
	bookmarkExists,
	cleanupWorkspace,
	createWorkspace,
	type ExecFn,
	getWorkspacePathByName,
	unarchiveWorkspace,
	workspaceDirExists,
	workspaceName as wsName,
} from "./workspace.js";

/**
 * Walk up from `startDir` looking for a `.jj/` directory.
 * Returns the absolute path to the repo root, or `undefined` when not found.
 */
function findJjRepoRoot(startDir: string): string | undefined {
	let current = resolve(startDir);
	for (;;) {
		const dotJj = join(current, ".jj");
		try {
			const st = statSync(dotJj);
			if (st.isDirectory()) return current;
		} catch {
			// .jj doesn't exist at this level, walk up
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/**
 * Check whether `jj` is on PATH by spawning `jj --version`.
 * Returns `true` when the binary is present and executable.
 */
async function isJjOnPath(pi: ExtensionAPI): Promise<boolean> {
	try {
		const result = await pi.exec("jj", ["--version"]);
		return result.code === 0;
	} catch {
		return false;
	}
}

/**
 * Workspaces root, loaded from `.pi/configs/sillajje.json`.
 * Initialised lazily in `session_start` once the repo root is known.
 */
let activeConfig: ReturnType<typeof loadSillajjeConfig> | undefined;

/**
 * @internal Test seam — override the SpawnFn used by stampChange.
 * When set, stampChange uses this instead of creating a real spawn.
 * Reset to undefined after each test.
 *
 * The seam is mirrored on `globalThis` because the extension may be loaded
 * through a different module instance than the test's imports — the jiti-based
 * extension loader imports with `moduleCache: false`, creating a separate
 * module graph. Writing the seam to `globalThis` lets tests set it from their
 * own module instance and have the loaded instance pick it up.
 */
const SEAM_KEY = "__sillajje_test_spawn_fn__";

let _testSpawnFn: SpawnFn | undefined;
export function setTestSpawnFn(fn: SpawnFn | undefined): void {
	_testSpawnFn = fn;
	const g = globalThis as Record<string, unknown>;
	if (fn === undefined) {
		delete g[SEAM_KEY];
	} else {
		g[SEAM_KEY] = fn;
	}
}

/**
 * Resolve the SpawnFn used for change stamping: the test seam (module
 * variable or globalThis mirror) or the real spawn factory.
 */
function resolveSpawnFn(): SpawnFn {
	const g = globalThis as Record<string, unknown>;
	return (
		_testSpawnFn ?? (g[SEAM_KEY] as SpawnFn | undefined) ?? createSpawnFn()
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Config values relevant to stampChange, extracted with explicit defaults.
 *
 * The defaults mirror those in `SillajjeConfigSchema` (config.ts).
 * TypeScript cannot see TypeBox's `Default()`, so we re-state them here
 * to get non-nullable types. Keep this in sync with the schema defaults.
 */
interface StampConfig {
	headerMode: "one_line" | "user_prompt";
	traceEnabled: boolean;
	traceDetail: "high" | "step" | "decision";
	/** Toggles for individual metadata block fields (tools, call_count, etc.). */
	metaFields: MetadataFieldToggles;
	/** Whether the entire metadata block is enabled. */
	metaEnabled: boolean;
	showUserPrompt: boolean;
	showResponse: boolean;
	maxAttempts: number;
	timeoutMs: number;
	model: string;
}

function getStampConfig(cfg: SillajjeConfig): StampConfig {
	return {
		headerMode: cfg.message?.header ?? "one_line",
		traceEnabled: cfg.message?.body?.trace?.enabled ?? true,
		traceDetail: cfg.message?.body?.trace?.detail ?? "high",
		metaFields: cfg.message?.body?.meta ?? {},
		metaEnabled: cfg.message?.body?.meta?.enabled ?? true,
		showUserPrompt: cfg.message?.body?.user_prompt ?? true,
		showResponse: cfg.message?.body?.response ?? true,
		maxAttempts: cfg.subGenerator?.retry?.maxAttempts ?? 3,
		timeoutMs: cfg.subGenerator?.timeoutMs ?? 30_000,
		model: cfg.subGeneratorModel ?? "openai/gpt-4o-mini",
	};
}

/**
 * Extract the concatenated text from an AssistantMessage's content blocks.
 * Filters to only `text` blocks and joins with newlines.
 *
 * Pure function — exported for unit testing (see `test/unit/extract-assistant-text.test.ts`).
 */
export function extractAssistantText(msg: {
	role: string;
	content?: Array<{ type: string; text?: string }> | null;
}): string {
	if (msg.role !== "assistant") return "";
	return (msg.content ?? [])
		.filter(
			(block): block is { type: "text"; text: string } =>
				block.type === "text",
		)
		.map((b) => b.text)
		.join("\n");
}

/**
 * sillajje — Auto-versioning for Pi agent sessions on jj.
 *
 * Every agent interaction becomes a jj change, leaving a reviewable trail
 * of all work done.
 */
export default function (pi: ExtensionAPI) {
	const state = new SessionState();
	// Start with no-op logger; recreated in session_start once config is loaded.
	let debug = createDebugLogger({ enabled: false });

	debug.event("extension_loaded");

	// Wrap pi.exec as an ExecFn adapter for the workspace module.
	const exec: ExecFn = (command, args, options) =>
		pi.exec(command, args, options);

	// -------------------------------------------------------------------
	// runPostInit — execute post-init commands after workspace creation
	// -------------------------------------------------------------------

	const runPostInit = async (ctx: {
		hasUI: boolean;
		ui: {
			notify: (msg: string, type: "info" | "warning" | "error") => void;
		};
	}) => {
		const commands = activeConfig?.postInit;
		if (!commands || commands.length === 0) return;

		const wsPath = state.getWorkspacePath();
		if (!wsPath) return;

		let allSucceeded = true;
		for (const cmd of commands) {
			if (ctx.hasUI) {
				ctx.ui.notify(`[sillajje] post-init: ${cmd}...`, "info");
			}
			try {
				const result = await pi.exec("sh", ["-c", cmd], {
					cwd: wsPath,
				});
				if (result.code !== 0) {
					allSucceeded = false;
					debug.error("post_init_failed", {
						cmd,
						code: result.code,
						stderr: result.stderr,
					});
					if (ctx.hasUI) {
						ctx.ui.notify(
							`[sillajje] post-init command failed (exit ${result.code}): ${cmd}`,
							"error",
						);
					}
				}
			} catch (err) {
				allSucceeded = false;
				debug.error("post_init_error", { cmd, err: String(err) });
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[sillajje] post-init command failed: ${cmd}`,
						"error",
					);
				}
			}
		}

		if (ctx.hasUI) {
			ctx.ui.notify(
				allSucceeded
					? `[sillajje] post-init: ${commands.length} command(s) completed`
					: "[sillajje] post-init: completed with errors",
				allSucceeded ? "info" : "warning",
			);
		}
	};

	// Helper: sync the footer status pill to current state.
	const syncPill = (ctx: {
		hasUI: boolean;
		ui: { setStatus: (key: string, text: string | undefined) => void };
	}) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("sillajje", formatPill(state));
	};

	// -----------------------------------------------------------------------
	// Stale detection — workspace deleted or jj disappeared mid-session
	// -----------------------------------------------------------------------

	/** Whether an active session's workspace directory no longer exists on disk. */
	const isWorkspaceGone = (): boolean => {
		const wsPath = state.getWorkspacePath();
		return state.isActive() && !!wsPath && !workspaceDirExists(wsPath);
	};

	/**
	 * Mark the session stale and notify the user once (deduped by isStale).
	 * A stale session cannot stamp or redirect tools safely — the user must
	 * unarchive or start a new session.
	 */
	const markStaleAndNotify = (
		ctx: {
			hasUI: boolean;
			ui: {
				notify: (
					msg: string,
					type: "info" | "warning" | "error",
				) => void;
			};
		},
		reason: string,
	): void => {
		if (state.isStale()) return;
		state.markStale();
		debug.error("session_stale", new Error(reason));
		if (ctx.hasUI) {
			ctx.ui.notify(
				`[sillajje] ${reason} — session marked stale. Use /sillajje unarchive or start a new session.`,
				"error",
			);
		}
	};

	/** Block reason shown to the agent when the session is stale. */
	const staleBlockReason =
		"The sillajje workspace for this session is no longer usable (stale). " +
		"Tell the user to run /sillajje unarchive or start a new session.";

	// -----------------------------------------------------------------------
	// session_start — detect jj, determine state
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		debug.event("session_start", { mode: ctx.mode, reason: _event.reason });
		state.reset();

		// Sillajje only activates in interactive TUI mode with a file-backed session.
		// Print mode (-p), RPC, JSON, and --no-session are excluded.
		if (
			ctx.mode !== "tui" ||
			ctx.sessionManager.getSessionFile() === undefined
		) {
			debug.event("session_start_skip", {
				reason: ctx.mode !== "tui" ? "non-tui-mode" : "no-session-file",
			});
			syncPill(ctx);
			return;
		}

		const jjAvailable = await isJjOnPath(pi);
		const repoRoot = jjAvailable ? findJjRepoRoot(ctx.cwd) : undefined;

		debug.event("jj_detection", { jjAvailable, repoRoot, cwd: ctx.cwd });

		state.setDetection(jjAvailable, repoRoot);

		// Load sillajje config (project-level `.pi/configs/sillajje.json`
		// or global `~/.pi/configs/sillajje.json`). Used for debug logging,
		// workspace root, and sub-generator model.
		activeConfig = loadSillajjeConfig(repoRoot);
		debug = createDebugLogger({ enabled: activeConfig.debug ?? false });

		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId !== undefined) {
			state.setSessionId(sessionId);
		}

		if (state.isActive() && repoRoot && sessionId) {
			debug.event("creating_workspace", { repoRoot, sessionId });
			try {
				const info = await createWorkspace(
					exec,
					repoRoot,
					sessionId,
					activeConfig.workspacesRoot ?? `${homedir()}/.pi/sillajje`,
				);
				state.setWorkspacePath(info.workspacePath);
				state.setSessionKey(info.sessionKey);

				// Run post-init commands (non-fatal — session activates regardless).
				await runPostInit(ctx);

				debug.event("workspace_ready", { path: info.workspacePath });
				syncPill(ctx);

				if (ctx.hasUI) {
					ctx.ui.notify(
						`[sillajje] workspace ready at ${info.workspacePath}`,
						"info",
					);
				}
			} catch (err) {
				debug.error("workspace_creation_failed", err);
				state.setInactive();
				syncPill(ctx);

				if (ctx.hasUI) {
					ctx.ui.notify(
						`[sillajje] workspace creation failed: ${String(err)}`,
						"error",
					);
				}
			}
		} else {
			syncPill(ctx);
		}
	});

	// -----------------------------------------------------------------------
	// before_agent_start — inject workspace path + capture prompt
	// -----------------------------------------------------------------------

	pi.on("before_agent_start", async (event, ctx) => {
		debug.event("before_agent_start", { promptLen: event.prompt.length });
		if (state.isInactive() || state.isArchived()) {
			debug.event("before_agent_start_skip", {
				reason: state.isInactive() ? "inactive" : "archived",
			});
			return undefined;
		}

		// Workspace deleted externally — no point injecting a dead path.
		if (state.isStale()) return undefined;
		if (isWorkspaceGone()) {
			markStaleAndNotify(ctx, "workspace directory no longer exists");
			return undefined;
		}

		// Record the prompt for change stamping.
		state.recordPrompt(event.prompt);
		// Ensure interaction flag is set — covers queued follow-ups that
		// may bypass the `input` event (where `startInteraction` normally runs).
		state.enableInteractionIfNotSteering();

		const wsPath = state.getWorkspacePath();
		if (!wsPath) return undefined;

		const workspaceBlock = [
			"",
			"## Sillajje Workspace",
			"",
			`Your file operations are isolated in a jj workspace at \`${wsPath}\`.`,
			"All read/write/edit paths will be redirected there automatically.",
			`bash commands run inside \`${wsPath}\`.`,
			"",
			"This is a clean checkout — gitignored files (node_modules, build artifacts, etc.)",
			"are absent. This is expected and normal. If the agent needs dependencies,",
			"install them using whatever method the repo recommends (e.g. pnpm install).",
			"",
			"Use **relative paths** for all file operations. Absolute paths that point",
			"back at the original repository will be blocked and instructed to use a",
			"relative path instead.",
			"",
		].join("\n");

		return {
			systemPrompt: event.systemPrompt + workspaceBlock,
		};
	});

	// -----------------------------------------------------------------------
	// agent_start — mark start time for elapsed tracking
	// -----------------------------------------------------------------------

	pi.on("agent_start", async () => {
		debug.event("agent_start");
		if (state.isInactive()) return undefined;
		state.markAgentStart();
		return undefined;
	});

	// -----------------------------------------------------------------------
	// agent_end — capture agent response + stamp the jj change
	// -----------------------------------------------------------------------

	const stampChange = async (ctx: {
		hasUI: boolean;
		ui: {
			notify: (msg: string, type: "info" | "warning" | "error") => void;
		};
	}) => {
		const sessionId = state.getSessionId();
		const wsPath = state.getWorkspacePath();
		if (!sessionId || !wsPath) {
			debug.event("stamp_skip", { reason: "no_session_or_ws" });
			return;
		}

		const sessionKey = state.getSessionKey() ?? sessionId;

		if (!state.hasNewInteraction()) {
			debug.event("stamp_skip", { reason: "no_new_interaction" });
			return;
		}

		const snapshot = state.getInteractionData(sessionKey);
		if (!snapshot) {
			debug.event("stamp_skip", {
				reason: "no_snapshot",
				hasPrompt: !!state.getInteractionPrompt(),
			});
			state.resetInteraction();
			return;
		}

		debug.event("stamp_change", {
			toolCount: snapshot.toolCallCount,
			elapsedMs: snapshot.elapsedMs,
		});

		const prompt = state.getInteractionPrompt() ?? "";
		const response = state.getInteractionResponse() ?? "";

		// Build transcript and get diff for the sub-generator.
		const transcript = [
			`User: ${prompt}`,
			"",
			`Tools used: ${snapshot.toolNames.join(", ")}`,
			"",
			"Assistant:",
			response,
		].join("\n");

		const diffResult = await pi.exec("jj", ["diff", "-r", "@"], {
			cwd: wsPath,
		});
		const diff = diffResult.code === 0 ? diffResult.stdout : "";

		// Get prior descriptions from the recent sillajje bookmark history.
		let priorDescriptions: string[] = [];
		try {
			const priorResult = await pi.exec(
				"jj",
				[
					"log",
					"-r",
					`ancestors(sillajje/${sessionKey})`,
					"--no-graph",
					"-T",
					"description.first_line()",
				],
				{ cwd: wsPath },
			);
			if (priorResult.code === 0) {
				priorDescriptions = priorResult.stdout
					.split("\n")
					.filter((l: string) => l.trim().length > 0)
					.slice(0, 5);
			}
		} catch {
			// Non-fatal — prior descriptions are optional context.
		}

		// Derive config values with defaults for the new message/subGenerator trees.
		const cfg = activeConfig ?? loadSillajjeConfig();
		const {
			headerMode,
			traceEnabled,
			traceDetail,
			metaFields,
			metaEnabled,
			showUserPrompt,
			showResponse,
			maxAttempts,
			timeoutMs,
			model,
		} = getStampConfig(cfg);

		// Build sub-generator context.
		const subCtx = {
			transcript,
			diff,
			previousDescriptions: priorDescriptions,
		};
		const spawnFn = resolveSpawnFn();

		// Run header and trace sub-generators in parallel when both are enabled.
		const headerCall =
			headerMode !== "user_prompt"
				? generateHeader(subCtx, spawnFn, {
						model,
						maxAttempts,
						timeoutMs,
						prompt,
					})
				: Promise.resolve(deriveSubject(prompt));

		const traceCall = traceEnabled
			? generateTrace(subCtx, spawnFn, {
					model,
					maxAttempts,
					timeoutMs,
					detail: traceDetail,
				})
			: Promise.resolve("");

		// Use Promise.all for parallel execution.
		const [subject, trace] = await Promise.all([headerCall, traceCall]);

		debug.event("sub_generator_result", {
			subject,
			traceLen: trace.length,
		});

		// Detect sub-generator fallback and notify.
		// Header: fell back when mode is "one_line" but result equals deriveSubject(prompt).
		// Trace: fell back when enabled but result is empty.
		if (headerMode !== "user_prompt" && subject === deriveSubject(prompt)) {
			debug.error(
				"sub_generator_failed",
				new Error("header exhausted retries"),
			);
			if (ctx.hasUI) {
				ctx.ui.notify(
					"[sillajje] commit subject generation failed — sub-generator exhausted retries",
					"warning",
				);
			}
		}
		if (traceEnabled && trace === "") {
			debug.error(
				"sub_generator_failed",
				new Error("trace exhausted retries"),
			);
			if (ctx.hasUI) {
				ctx.ui.notify(
					"[sillajje] commit trace generation failed — sub-generator exhausted retries",
					"warning",
				);
			}
		}

		// Build metadata string with optional field toggles.
		const metaStr = metaEnabled ? buildMetadata(snapshot, metaFields) : "";

		// Assemble body with config-gated sections.
		const body = buildCommitBody({
			subject,
			trace: traceEnabled ? smartWrap(trace, 72) : "",
			prompt: showUserPrompt ? prompt : "",
			metadata: metaEnabled ? metaStr : "",
			response: showResponse ? response : "",
		});

		try {
			// 0. Ensure the workspace working copy isn't stale.
			await pi.exec("jj", ["workspace", "update-stale"], {
				cwd: wsPath,
			});

			// 1. Describe the working copy with the interaction body.
			const descResult = await pi.exec("jj", ["describe", "-m", body], {
				cwd: wsPath,
			});
			debug.event("jj_describe", {
				code: descResult.code,
				stderr: descResult.stderr?.slice(0, 200),
			});
			if (descResult.code !== 0 && ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] jj describe failed (exit ${descResult.code}): ${descResult.stderr}`,
					"error",
				);
			}

			// 2. Set the bookmark to point to the current working copy.
			const bookmarkResult = await pi.exec(
				"jj",
				["bookmark", "set", `sillajje/${sessionKey}`, "-r", "@"],
				{ cwd: wsPath },
			);
			debug.event("jj_bookmark_set", { code: bookmarkResult.code });
			if (bookmarkResult.code !== 0 && ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] jj bookmark set failed (exit ${bookmarkResult.code}): ${bookmarkResult.stderr}`,
					"error",
				);
			}

			// 3. Seal the current working copy and start a fresh one on top.
			//    This ensures each interaction is a separate change in `jj log`.
			//    No -m flag — the new empty change should have no description.
			const newResult = await pi.exec("jj", ["new"], { cwd: wsPath });
			debug.event("jj_new", { code: newResult.code });
			if (newResult.code !== 0 && ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] jj new failed (exit ${newResult.code}): ${newResult.stderr}`,
					"error",
				);
			}
		} catch (err) {
			debug.error("stamp_error", err);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] change stamping failed: ${String(err)}`,
					"error",
				);
			}
		}

		// Always reset interaction state — even on failure we clean up for the next one.
		state.resetInteraction();
	};

	// -----------------------------------------------------------------------
	// stampManual — /sillajje stamp command
	// -----------------------------------------------------------------------

	const stampManual = async (ctx: {
		hasUI: boolean;
		ui: {
			notify: (msg: string, type: "info" | "warning" | "error") => void;
		};
	}) => {
		const sessionId = state.getSessionId();
		const wsPath = state.getWorkspacePath();
		if (!sessionId || !wsPath) {
			debug.event("stamp_manual_skip", { reason: "no_session_or_ws" });
			if (ctx.hasUI) {
				ctx.ui.notify(
					"[sillajje] cannot stamp: no active session or workspace",
					"error",
				);
			}
			return;
		}

		const sessionKey = state.getSessionKey() ?? sessionId;

		debug.event("stamp_manual_start");

		// Get the diff for the sub-generator.
		const diffResult = await pi.exec("jj", ["diff", "-r", "@"], {
			cwd: wsPath,
		});
		const diff = diffResult.code === 0 ? diffResult.stdout : "";

		// Skip if there's nothing to stamp.
		if (!diff || diff.trim().length === 0) {
			debug.event("stamp_manual_skip", { reason: "no_diff" });
			if (ctx.hasUI) {
				ctx.ui.notify(
					"[sillajje] nothing to stamp — working copy has no changes",
					"info",
				);
			}
			return;
		}

		// Get config values.
		const cfg = activeConfig ?? loadSillajjeConfig();
		const { maxAttempts, timeoutMs, model } = getStampConfig(cfg);
		const spawnFn = resolveSpawnFn();

		// Generate a classic conventional commit header from the diff alone.
		const subject = await generateManualHeader(diff, spawnFn, {
			model,
			maxAttempts,
			timeoutMs,
		});

		debug.event("stamp_manual_header", { subject });

		// Handle sub-generator fallback.
		if (subject === "chore: manual checkpoint") {
			debug.error(
				"stamp_manual_header_failed",
				new Error("sub-generator exhausted retries"),
			);
			if (ctx.hasUI) {
				ctx.ui.notify(
					"[sillajje] commit subject generation failed — using fallback",
					"warning",
				);
			}
		}

		// Build body: subject + metadata (session key only).
		const metaLine = `Meta: sillajje/${sessionKey}`;
		const body = `${subject}\n\n${metaLine}`;

		try {
			// 1. Ensure the workspace working copy isn't stale.
			await pi.exec("jj", ["workspace", "update-stale"], {
				cwd: wsPath,
			});

			// 2. Describe the working copy with the commit body.
			const descResult = await pi.exec("jj", ["describe", "-m", body], {
				cwd: wsPath,
			});
			debug.event("jj_describe", {
				code: descResult.code,
				stderr: descResult.stderr?.slice(0, 200),
			});
			if (descResult.code !== 0 && ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] jj describe failed (exit ${descResult.code}): ${descResult.stderr}`,
					"error",
				);
			}

			// 3. Set the bookmark to point to the current working copy.
			const bookmarkResult = await pi.exec(
				"jj",
				["bookmark", "set", `sillajje/${sessionId}`, "-r", "@"],
				{ cwd: wsPath },
			);
			debug.event("jj_bookmark_set", { code: bookmarkResult.code });
			if (bookmarkResult.code !== 0 && ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] jj bookmark set failed (exit ${bookmarkResult.code}): ${bookmarkResult.stderr}`,
					"error",
				);
			}

			// 4. Seal the current change and start a fresh one on top.
			const newResult = await pi.exec("jj", ["new"], { cwd: wsPath });
			debug.event("jj_new", { code: newResult.code });
			if (newResult.code !== 0 && ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] jj new failed (exit ${newResult.code}): ${newResult.stderr}`,
					"error",
				);
			}

			if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] workspace stamped: ${subject}`,
					"info",
				);
			}
		} catch (err) {
			debug.error("stamp_manual_error", err);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] manual stamp failed: ${String(err)}`,
					"error",
				);
			}
		}
	};

	pi.on("agent_end", async (event, ctx) => {
		debug.event("agent_end", { messageCount: event.messages.length });
		if (state.isInactive()) return undefined;

		// Stale session (workspace deleted or jj disappeared): don't stamp.
		if (state.isStale()) return undefined;
		if (isWorkspaceGone()) {
			markStaleAndNotify(ctx, "workspace directory no longer exists");
			return undefined;
		}
		if (!(await isJjOnPath(pi))) {
			markStaleAndNotify(ctx, "jj is no longer on PATH");
			return undefined;
		}

		// Accumulate this agent run segment into the cumulative elapsed timer.
		// This handles retry/compact scenarios where `agent_start` fires again
		// mid-interaction — each segment adds to the total rather than resetting.
		state.markAgentEnd();

		// Find the last assistant message and extract its text.
		const assistantMsgs = event.messages.filter(
			(m) => (m as { role: string }).role === "assistant",
		);

		// Count thinking blocks across all assistant messages (ticket 06).
		for (const msg of assistantMsgs) {
			const content =
				(msg as { content?: Array<{ type: string }> }).content ?? [];
			for (const block of content) {
				if (block.type === "thinking") {
					state.recordThinkingBlock();
				}
			}
		}

		const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
		if (lastAssistant) {
			state.recordAgentResponse(
				extractAssistantText(
					lastAssistant as {
						role: string;
						content: Array<{ type: string; text?: string }>;
					},
				),
			);
		}

		// Stamp the change. `agent_settled` would be ideal (fires after
		// retries/compactions), but it does not reliably reach extension
		// handlers in this Pi version. `agent_end` is the next best point.
		await stampChange(ctx);
		return undefined;
	});

	// -----------------------------------------------------------------------
	// agent_settled — kept for logging; actual stamping moved to agent_end
	// because agent_settled does not reliably reach extension handlers.
	// -----------------------------------------------------------------------

	pi.on("agent_settled", async () => {
		debug.event("agent_settled");
	});

	// -----------------------------------------------------------------------
	// tool_call — redirect paths + record tool usage
	// -----------------------------------------------------------------------

	pi.on("tool_call", async (event, ctx) => {
		debug.event("tool_call", { toolName: event.toolName });
		if (state.isInactive()) return undefined;

		// Stale session — block tools so nothing writes to the real repo.
		if (state.isStale()) {
			return { block: true, reason: staleBlockReason };
		}
		if (isWorkspaceGone()) {
			markStaleAndNotify(ctx, "workspace directory no longer exists");
			return { block: true, reason: staleBlockReason };
		}

		const info = redirect(
			event,
			state.getWorkspacePath() ?? "",
			state.getRepoRoot(),
		);

		// Block absolute paths that point back at the original repo — the
		// agent should use relative paths to stay inside the workspace.
		if (info.repoRelativePath) {
			debug.event("tool_call_blocked_absolute", {
				toolName: event.toolName,
				path: info.originalPath,
			});
			return {
				block: true,
				reason: [
					`Absolute path "${info.originalPath}" points into the original repo, not the sillajje workspace.`,
					`Use a relative path instead (e.g. "${info.repoRelativePath}") to write inside the workspace.`,
					"Use an absolute path only if you intentionally need to operate outside the workspace.",
				].join(" "),
			};
		}

		// Track tool calls for metadata.
		state.recordToolCall(event.toolName);
		return undefined;
	});

	// -----------------------------------------------------------------------
	// input — block archived sessions (issue 06), pass-through otherwise
	// -----------------------------------------------------------------------

	pi.on("input", async (event, ctx) => {
		debug.event("input", {
			streamingBehavior: event.streamingBehavior,
			source: event.source,
		});
		state.markPrompted();

		// Detect new interaction vs steering: `steer` folds into the current one.
		state.startInteraction(event.streamingBehavior);

		if (state.isInactive()) return undefined;
		if (state.isStale()) {
			// Already notified when staleness was detected — prompts pass
			// through so the user can still run /sillajje commands.
			return undefined;
		}
		if (state.isArchived()) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"[sillajje] This session is archived. Use /sillajje unarchive to resume.",
					"warning",
				);
			}
			return { action: "handled" as const };
		}
		return undefined;
	});

	// -----------------------------------------------------------------------
	// user_bash — redirect !/!! commands to workspace directory
	// -----------------------------------------------------------------------

	pi.on("user_bash", async (event, ctx) => {
		debug.event("user_bash", { command: event.command });

		if (state.isInactive()) return undefined;

		const wsPath = state.getWorkspacePath();
		if (!wsPath) return undefined;

		if (state.isStale()) return undefined;
		if (isWorkspaceGone()) {
			markStaleAndNotify(ctx, "workspace directory no longer exists");
			return undefined;
		}

		const ops = createLocalBashOperations();
		const result: UserBashEventResult = {
			operations: {
				exec: (command, _cwd, options) =>
					ops.exec(command, wsPath, options),
			},
		};

		return result;
	});

	// -----------------------------------------------------------------------
	// session_shutdown — clean up unused workspaces
	// -----------------------------------------------------------------------

	pi.on("session_shutdown", async (_event, ctx) => {
		if (state.isInactive() || state.isArchived() || state.isStale()) return;

		const wsPath = state.getWorkspacePath();
		const sessionId = state.getSessionId();
		if (!wsPath || !sessionId) return;

		if (!state.hasUserPrompted()) {
			await cleanupWorkspace(
				exec,
				wsName(state.getSessionKey() ?? sessionId),
				wsPath,
			);
			syncPill(ctx);
		}
	});

	// -----------------------------------------------------------------------
	// rebaseFoldPreamble — shared preamble for /sillajje rebase|fold
	// -----------------------------------------------------------------------

	/**
	 * Shared preamble for the `/sillajje rebase|fold <rev>` subcommands (PRD):
	 * parse the args, resolve the target session's workspace, detect session
	 * state, rebase the session working copy onto `<rev>` as a merge commit,
	 * detect file-level conflicts, and sync the working copy.
	 *
	 * Returns the resolved target context when the preamble succeeded, or
	 * `undefined` when the caller should abort (an error was already notified).
	 */
	const rebaseFoldPreamble = async (
		ctx: {
			hasUI: boolean;
			ui: {
				notify: (
					msg: string,
					type: "info" | "warning" | "error",
				) => void;
			};
		},
		subcommand: "rebase" | "fold",
		args: string,
	): Promise<
		{ rev: string; sessionKey: string; wsPath: string } | undefined
	> => {
		// `args` includes the subcommand token itself (matching the other cases) —
		// hand the parser only what follows `/sillajje <subcommand>`.
		const { rev, sessionId } = parseRebaseFoldArgs(
			args.split(/\s+/).slice(1).join(" "),
		);
		if (!rev) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] usage: /sillajje ${subcommand} <rev> [--session <id>]`,
					"warning",
				);
			}
			return undefined;
		}

		const repoRoot = state.getRepoRoot();
		if (!repoRoot) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] cannot ${subcommand}: no jj repo detected`,
					"error",
				);
			}
			return undefined;
		}

		// Target session: the current one by default, or the one named by
		// `--session <id>`. `sessionKey` is the bookmark key (`sillajje/<key>`),
		// which may carry a `-N` collision suffix for the current session.
		const sessionKey = sessionId ?? state.getSessionKey();
		if (!sessionKey) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] no session ID available to ${subcommand}`,
					"error",
				);
			}
			return undefined;
		}

		// Resolve the workspace path: stored for the current session, looked up
		// from `jj workspace list` for any other session.
		let wsPath: string | undefined;
		if (sessionKey === state.getSessionKey() && state.getWorkspacePath()) {
			wsPath = state.getWorkspacePath();
		} else {
			try {
				wsPath = await getWorkspacePathByName(exec, wsName(sessionKey));
			} catch {
				// getWorkspacePathByName catches errors internally
			}
		}

		// Three-state session detection (PRD): no bookmark → not a sillajje
		// session; bookmark without a workspace → archived; both → active, proceed.
		if (!wsPath) {
			const hasBookmark = await bookmarkExists(
				exec,
				`sillajje/${sessionKey}`,
				repoRoot,
			);
			if (!hasBookmark) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[sillajje] session ${sessionKey} is not a sillajje session — no bookmark sillajje/${sessionKey}`,
						"error",
					);
				}
				return undefined;
			}
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] session ${sessionKey} is archived — unarchive it first`,
					"error",
				);
			}
			return undefined;
		}

		debug.event(`${subcommand}_preamble`, { rev, sessionKey, wsPath });

		try {
			// Rebase the session working copy onto `<rev>` and the session
			// bookmark. Two `--onto` flags create a merge commit that brings
			// `<rev>` into the session's ancestry while keeping the session
			// history attached via its bookmark.
			const rebaseResult = await pi.exec(
				"jj",
				[
					"rebase",
					"-s",
					"@",
					"-o",
					rev,
					"-o",
					`sillajje/${sessionKey}`,
				],
				{ cwd: wsPath },
			);
			debug.event("jj_rebase", {
				code: rebaseResult.code,
				stderr: rebaseResult.stderr?.slice(0, 200),
			});
			if (rebaseResult.code !== 0) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[sillajje] ${subcommand} failed (exit ${rebaseResult.code}): ${rebaseResult.stderr}`,
						"error",
					);
				}
				return undefined;
			}

			// Detect file-level conflicts. `jj resolve --list` exits 0 with
			// non-empty stdout when conflicts exist; without conflicts it exits
			// non-zero (2) and reports "No conflicts found" on stderr — so the
			// conflict signal is exit 0 AND non-empty stdout, not output alone.
			const resolveResult = await pi.exec("jj", ["resolve", "--list"], {
				cwd: wsPath,
			});
			debug.event("jj_resolve_list", {
				code: resolveResult.code,
				conflicts: resolveResult.stdout,
			});
			if (
				resolveResult.code === 0 &&
				resolveResult.stdout.trim() !== ""
			) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[sillajje] ${subcommand} produced file-level conflicts — resolve them manually:\n${resolveResult.stdout.trim()}`,
						"warning",
					);
				}
				return undefined;
			}

			// Sync the target workspace working copy (no-op when already current).
			const staleResult = await pi.exec(
				"jj",
				["workspace", "update-stale"],
				{ cwd: wsPath },
			);
			debug.event("jj_update_stale", {
				code: staleResult.code,
				stderr: staleResult.stderr?.slice(0, 200),
			});
			if (staleResult.code !== 0 && ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] jj workspace update-stale failed (exit ${staleResult.code}): ${staleResult.stderr}`,
					"error",
				);
			}
		} catch (err) {
			debug.error(`${subcommand}_preamble_error`, err);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] ${subcommand} failed: ${String(err)}`,
					"error",
				);
			}
			return undefined;
		}

		return { rev, sessionKey, wsPath };
	};

	// -----------------------------------------------------------------------
	// /sillajje command — status subcommand
	// -----------------------------------------------------------------------

	pi.registerCommand("sillajje", {
		description: "Manage sillajje session versioning",
		handler: async (args, ctx) => {
			const [subcommand] = args.trim().split(/\s+/).filter(Boolean);

			switch (subcommand) {
				case "status": {
					const lifecycle = state.getLifecycle();
					const lines: string[] = [
						`Sillajje session status: ${lifecycle}`,
					];

					if (state.getRepoRoot()) {
						lines.push(`Repo root: ${state.getRepoRoot()}`);
					}
					if (state.getSessionId()) {
						lines.push(`Session ID: ${state.getSessionId()}`);
					}
					if (state.getWorkspacePath()) {
						lines.push(`Workspace: ${state.getWorkspacePath()}`);
					}

					const statusText = lines.join("\n");

					if (ctx.hasUI) {
						ctx.ui.notify(statusText, "info");
					}
					break;
				}

				case "archive": {
					const parts = args.trim().split(/\s+/);
					const targetSessionId = parts[1] || state.getSessionKey();

					if (!targetSessionId) {
						if (ctx.hasUI) {
							ctx.ui.notify(
								"[sillajje] no session ID available to archive",
								"error",
							);
						}
						break;
					}

					const wsNameInternal = wsName(targetSessionId);
					let wsPath: string | undefined;

					// If archiving the current session, use the stored workspace path.
					// Otherwise, look it up from jj workspace list.
					if (
						targetSessionId === state.getSessionKey() &&
						state.getWorkspacePath()
					) {
						wsPath = state.getWorkspacePath();
					} else {
						try {
							wsPath = await getWorkspacePathByName(
								exec,
								wsNameInternal,
							);
						} catch {
							// getWorkspacePathByName catches errors internally
						}
					}

					if (!wsPath) {
						// Workspace already gone — just update state if it's the current session.
						if (
							targetSessionId === state.getSessionKey() &&
							state.isActive()
						) {
							state.setArchived();
							state.clearWorkspacePath();
							state.resetInteraction();
							syncPill(ctx);
							if (ctx.hasUI) {
								ctx.ui.notify(
									`[sillajje] session ${targetSessionId} archived (workspace already gone)`,
									"info",
								);
							}
						} else if (ctx.hasUI) {
							ctx.ui.notify(
								`[sillajje] no workspace found for session ${targetSessionId}`,
								"warning",
							);
						}
						break;
					}

					// Forget the workspace and delete the directory.
					await cleanupWorkspace(exec, wsNameInternal, wsPath);

					// Update state if this is the current session.
					if (targetSessionId === state.getSessionKey()) {
						state.setArchived();
						state.clearWorkspacePath();
						state.resetInteraction();
					}

					syncPill(ctx);

					if (ctx.hasUI) {
						ctx.ui.notify(
							`[sillajje] session ${targetSessionId} archived`,
							"info",
						);
					}
					break;
				}

				case "stamp": {
					await stampManual(ctx);
					syncPill(ctx);
					break;
				}

				case "unarchive": {
					const parts = args.trim().split(/\s+/);
					const targetSessionId = parts[1];

					if (!targetSessionId) {
						if (ctx.hasUI) {
							ctx.ui.notify(
								"[sillajje] usage: /sillajje unarchive <session-id>",
								"warning",
							);
						}
						break;
					}

					const repoRoot = state.getRepoRoot();
					const workspacesRoot = activeConfig?.workspacesRoot;
					if (!repoRoot || !workspacesRoot) {
						if (ctx.hasUI) {
							ctx.ui.notify(
								"[sillajje] cannot unarchive: no repo root or config",
								"error",
							);
						}
						break;
					}

					try {
						const info = await unarchiveWorkspace(
							exec,
							repoRoot,
							targetSessionId,
							workspacesRoot,
						);

						// Restore state for the unarchived session.
						state.setSessionId(targetSessionId);
						state.setSessionKey(info.sessionKey);
						state.setActive();
						state.setWorkspacePath(info.workspacePath);
						syncPill(ctx);

						if (ctx.hasUI) {
							ctx.ui.notify(
								`[sillajje] workspace restored at ${info.workspacePath}`,
								"info",
							);
						}
					} catch (err) {
						debug.error("unarchive_failed", err);
						if (ctx.hasUI) {
							ctx.ui.notify(
								`[sillajje] unarchive failed: ${String(err)}`,
								"error",
							);
						}
					}
					break;
				}

				case "rebase": {
					const target = await rebaseFoldPreamble(
						ctx,
						"rebase",
						args,
					);
					if (!target) break;

					// No state transition — the session stays active after a
					// successful rebase so the user can keep working.
					if (ctx.hasUI) {
						ctx.ui.notify(
							`[sillajje] session ${target.sessionKey} rebased onto ${target.rev}`,
							"info",
						);
					}
					break;
				}

				case "fold": {
					const target = await rebaseFoldPreamble(ctx, "fold", args);
					if (!target) break;

					const { rev, sessionKey, wsPath } = target;
					debug.event("fold_start", { rev, sessionKey, wsPath });

					try {
						// 1. Create an empty change on `<rev>` (`<rev>+`) without moving
						//    the working copy — the fold source stays at `@` (the merge
						//    commit from the preamble).
						const newResult = await pi.exec(
							"jj",
							["new", rev, "--no-edit"],
							{ cwd: wsPath },
						);
						debug.event("jj_new_fold", {
							code: newResult.code,
							stderr: newResult.stderr?.slice(0, 120),
						});
						if (newResult.code !== 0) {
							throw new Error(
								`jj new failed (exit ${newResult.code}): ${newResult.stderr}`,
							);
						}

						// The folded change id, parsed from `jj new` output ("Created
						// new commit <change_id> ..." — jj prints status messages to
						// stderr). Referencing it by id avoids the `<rev>+` revset,
						// which is ambiguous once the preamble's merge commit also
						// descends from `<rev>`.
						const foldId = /Created new commit (\S+)/.exec(
							newResult.stderr ?? "",
						)?.[1];
						if (!foldId) {
							throw new Error(
								`could not parse folded commit id from jj new output: ${newResult.stderr}`,
							);
						}

						// 2. Copy the merged session content into the folded change.
						//    The source is `@` (the preamble's merge commit) — the
						//    session bookmark alone would lack the upstream content
						//    brought in by the rebase.
						const restoreResult = await pi.exec(
							"jj",
							["restore", "--from", "@", "--to", foldId],
							{ cwd: wsPath },
						);
						debug.event("jj_restore_fold", {
							code: restoreResult.code,
						});
						if (restoreResult.code !== 0) {
							throw new Error(
								`jj restore failed (exit ${restoreResult.code}): ${restoreResult.stderr}`,
							);
						}

						// 3. Generate a conventional-commit subject from the folded diff,
						//    via the same sub-generator used by `/sillajje stamp`.
						const diffResult = await pi.exec(
							"jj",
							["diff", "-r", foldId],
							{
								cwd: wsPath,
							},
						);
						const diff =
							diffResult.code === 0 ? diffResult.stdout : "";
						const cfg = activeConfig ?? loadSillajjeConfig();
						const { maxAttempts, timeoutMs, model } =
							getStampConfig(cfg);
						const subject = await generateManualHeader(
							diff,
							resolveSpawnFn(),
							{ model, maxAttempts, timeoutMs },
						);
						debug.event("fold_header", { subject });

						// 4. Describe the folded change with the generated subject.
						const descResult = await pi.exec(
							"jj",
							["describe", "-r", foldId, "-m", subject],
							{ cwd: wsPath },
						);
						debug.event("jj_describe_fold", {
							code: descResult.code,
						});
						if (descResult.code !== 0) {
							throw new Error(
								`jj describe failed (exit ${descResult.code}): ${descResult.stderr}`,
							);
						}

						// 5. Archive the session as a practical convenience: forget the
						//    workspace and delete its directory. The
						//    `sillajje/<sessionKey>` bookmark intentionally survives as
						//    sillage.
						await cleanupWorkspace(
							exec,
							wsName(sessionKey),
							wsPath,
						);
						if (sessionKey === state.getSessionKey()) {
							state.setArchived();
							state.clearWorkspacePath();
							state.resetInteraction();
						}
						syncPill(ctx);

						if (ctx.hasUI) {
							ctx.ui.notify(
								`[sillajje] session ${sessionKey} folded — commit at ${rev}+ (switch to it in your main checkout)`,
								"info",
							);
						}
					} catch (err) {
						debug.error("fold_error", err);
						if (ctx.hasUI) {
							ctx.ui.notify(
								`[sillajje] fold failed: ${String(err)}`,
								"error",
							);
						}
					}
					break;
				}

				default: {
					if (ctx.hasUI) {
						ctx.ui.notify(
							"Usage: /sillajje [status|stamp|archive|unarchive|rebase|fold]",
							"warning",
						);
					}
					break;
				}
			}
		},
	});
}
