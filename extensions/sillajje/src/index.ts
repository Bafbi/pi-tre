import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { Message } from "@earendil-works/pi-ai";
import {
	createLocalBashOperations,
	type ExtensionAPI,
	type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { loadSillajjeConfig } from "./config.js";
import { createDebugLogger } from "./debug-log.js";
import { redirect } from "./path-redirect.js";
import { parseRebaseFoldArgs } from "./rebase-fold.js";
import type { StampInput, StampStatus } from "./stamp/index.js";
import {
	stamp,
	setSessionBookmark as stampSetBookmark,
} from "./stamp/index.js";
import { SessionState } from "./state.js";
import { formatPill } from "./status-pill.js";
import type { SpawnFn } from "./sub-generator.js";
import { createSpawnFn, generateManualHeader } from "./sub-generator.js";
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
	// setSessionBookmark — point the session bookmark at the working copy
	// -------------------------------------------------------------------

	/**
	 * Point the `sillajje/<session-key>` bookmark at the workspace's current
	 * working copy (`@`). The bookmark is the stable handle on session work:
	 * `jj show`, `jj diff -r 'sillajje/<id>'`, unarchive, and bookmarkExists
	 * all resolve through it, so it must exist from the first interaction.
	 *
	 * Failures are logged (event + error) and surfaced via the UI when
	 * available, but never thrown — callers treat a failed bookmark set as
	 * non-fatal (the stamp flow retries on the next interaction).
	 */
	const setSessionBookmark = async (sessionKey: string, wsPath: string) => {
		try {
			await stampSetBookmark(exec, sessionKey, wsPath);
		} catch (err) {
			debug.error("bookmark_set_failed", err);
		}
	};

	// -------------------------------------------------------------------
	// createStatusSink — shared status→notification mapping for stamp ops
	// -------------------------------------------------------------------

	/**
	 * Build an onStatus sink that maps StampStatus events to debug logs and
	 * UI notifications. Shared by stampChange and stampManual to avoid
	 * duplicating the mapping policy.
	 */
	const createStatusSink = (ctx: {
		hasUI: boolean;
		ui: {
			notify: (msg: string, type: "info" | "warning" | "error") => void;
		};
	}) => {
		return (s: StampStatus) => {
			if (s.kind === "phase") {
				debug.event(`stamp_phase_${s.code}`, {});
			} else if (s.kind === "warning") {
				debug.error(`stamp_warning_${s.code}`, new Error(s.message));
				if (ctx.hasUI) {
					ctx.ui.notify(`[sillajje] ${s.message}`, "warning");
				}
			} else if (s.kind === "error") {
				debug.error(`stamp_error_${s.code}`, new Error(s.message));
				if (ctx.hasUI) {
					ctx.ui.notify(`[sillajje] ${s.message}`, "error");
				}
			}
		};
	};

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

		// Record the user prompt as a message so the full transcript is
		// available to the stamp module at agent_end (which only carries
		// assistant messages).
		state.recordAgentMessages([
			{
				role: "user",
				content: event.prompt,
				timestamp: Date.now(),
			} as Message,
		]);

		// Ensure interaction flag is set — covers queued follow-ups that
		// may bypass the `input` event (where `startInteraction` normally runs).
		state.enableInteractionIfNotSteering();

		const wsPath = state.getWorkspacePath();
		if (!wsPath) return undefined;

		// Ensure the session bookmark exists before the agent works, so
		// `sillajje/<session-key>` resolves from the very first interaction —
		// not just after the first stamp. This matters for:
		//   - `jj show`, `jj diff -r 'sillajje/<id>'`, and ad-hoc revsets
		//   - the extension's own unarchive (`jj workspace add --revision
		//     sillajje/<id>`) and bookmarkExists checks, which assume the
		//     bookmark is a stable handle on session work
		// Non-fatal: if this fails (jj unavailable, race), the first stamp
		// will still create the bookmark.
		const sessionKey = state.getSessionKey();
		if (sessionKey) {
			await setSessionBookmark(sessionKey, wsPath);
		}

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
		// An `agent_start` after a deferred error end is a retry/compact
		// continuation — the interaction is still live, so drop the
		// pending-finalize flag.
		state.clearPendingFinalize();
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

		const messages = state.getInteractionMessages();
		if (!messages) {
			debug.event("stamp_skip", { reason: "no_messages" });
			state.resetInteraction();
			return;
		}

		debug.event("stamp_change", { messageCount: messages.length });

		const input: StampInput = {
			interaction: messages as Message[],
			workspace: { sessionKey, wsPath },
			rev: "@",
		};

		const deps = {
			exec,
			spawn: resolveSpawnFn(),
			config: activeConfig ?? loadSillajjeConfig(),
			onStatus: createStatusSink(ctx),
		};

		const result = await stamp(input, deps);

		if (result.ok) {
			debug.event("stamp_done", {
				subject: result.subject,
				rev: result.rev,
			});
		} else if (result.reason === "failed") {
			debug.error("stamp_failed", new Error("stamp returned failed"));
			if (ctx.hasUI) {
				ctx.ui.notify("[sillajje] change stamping failed", "error");
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

		// A manual stamp seals the working copy, which covers any pending
		// (error-ended) interaction — nothing left to finalize later.
		state.clearPendingFinalize();

		const input: StampInput = {
			interaction: null,
			workspace: { sessionKey, wsPath },
			rev: "@",
		};

		const deps = {
			exec,
			spawn: resolveSpawnFn(),
			config: activeConfig ?? loadSillajjeConfig(),
			onStatus: createStatusSink(ctx),
		};

		const result = await stamp(input, deps);

		if (result.ok) {
			debug.event("stamp_manual_done", {
				subject: result.subject,
				rev: result.rev,
			});
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] workspace stamped: ${result.subject}`,
					"info",
				);
			}
		} else if (result.reason === "no-changes") {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"[sillajje] nothing to stamp — working copy has no changes",
					"info",
				);
			}
		} else {
			debug.error(
				"stamp_manual_failed",
				new Error("stamp returned failed"),
			);
			if (ctx.hasUI) {
				ctx.ui.notify("[sillajje] manual stamp failed", "error");
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

		// Store messages from this agent run. Messages accumulate across retry
		// segments so the full transcript is available at stamp time.
		state.recordAgentMessages(event.messages as Message[]);

		// Check if this run ended in an error.
		const assistantMsgs = event.messages.filter(
			(m) => (m as { role: string }).role === "assistant",
		);
		const lastAssistant = assistantMsgs[assistantMsgs.length - 1];

		// A run that ended in an error (stopReason "error" — timeout, 5xx,
		// rate limit, network...) is not necessarily the end of the
		// interaction: Pi auto-retries (or compacts-and-retries on context
		// overflow), which fires `agent_start` again mid-interaction.
		// Stamping here would seal a partial interaction and reset the
		// interaction state, so the true final `agent_end` would skip
		// stamping entirely. Defer instead: the continuation's `agent_start`
		// clears the pending flag; otherwise the interaction is finalized
		// on the next `input` or at `session_shutdown`.
		if (
			lastAssistant &&
			(lastAssistant as { stopReason?: string }).stopReason === "error"
		) {
			debug.event("stamp_deferred", { reason: "agent_run_error" });
			state.recordAgentEndError();
			state.markPendingFinalize();
			return undefined;
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

		// A previous interaction that ended in an error (and was not retried)
		// is finalized now, before the new interaction overwrites its prompt
		// and response. Stamping seals it as its own change and starts fresh.
		if (
			state.hasPendingFinalize() &&
			!state.isInactive() &&
			!state.isStale()
		) {
			await stampChange(ctx);
		}

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

		// Finalize an interaction that ended in an error and was never
		// retried — otherwise its work is left un-stamped in the working copy.
		if (state.hasPendingFinalize()) {
			await stampChange(ctx);
		}

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
			args.trim().split(/\s+/).slice(1).join(" "),
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
				// The rebase succeeded — a failed sync is a non-fatal warning, not an
				// error that contradicts the success notification below.
				ctx.ui.notify(
					`[sillajje] jj workspace update-stale failed (exit ${staleResult.code}): ${staleResult.stderr}`,
					"warning",
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
						// Identify the folded change by diffing `children(<rev>)` before and
						// after `jj new`. An explicit query is immune to jj message format
						// changes and quiet output (which would break parsing `jj new`'s
						// stderr), and works alongside other pre-existing descendants of
						// `<rev>` — which rule out the `<rev>+` revset, since the preamble's
						// merge commit also descends from `<rev>`.
						const childTemplate = 'change_id.short() ++ "\\n"';
						const beforeResult = await pi.exec(
							"jj",
							[
								"log",
								"-r",
								`children(${rev})`,
								"--no-graph",
								"-T",
								childTemplate,
							],
							{ cwd: wsPath },
						);
						if (beforeResult.code !== 0) {
							throw new Error(
								`jj log failed (exit ${beforeResult.code}): ${beforeResult.stderr}`,
							);
						}
						const beforeChildren = new Set(
							beforeResult.stdout
								.split("\n")
								.map((l) => l.trim())
								.filter(Boolean),
						);

						// Create an empty change on `<rev>` (`<rev>+`) without moving the
						// working copy — the fold source stays at `@` (the merge commit
						// from the preamble).
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

						const afterResult = await pi.exec(
							"jj",
							[
								"log",
								"-r",
								`children(${rev})`,
								"--no-graph",
								"-T",
								childTemplate,
							],
							{ cwd: wsPath },
						);
						if (afterResult.code !== 0) {
							throw new Error(
								`jj log failed (exit ${afterResult.code}): ${afterResult.stderr}`,
							);
						}
						const newChildren = afterResult.stdout
							.split("\n")
							.map((l) => l.trim())
							.filter(Boolean)
							.filter((id) => !beforeChildren.has(id));

						if (newChildren.length !== 1) {
							// A failed fold must not leave the empty change on `<rev>` —
							// abandon whatever appeared between the two queries.
							for (const id of newChildren) {
								await pi.exec("jj", ["abandon", id], {
									cwd: wsPath,
								});
							}
							throw new Error(
								`could not identify the folded change created on ${rev}`,
							);
						}
						const foldId = newChildren[0];

						// 1. Copy the merged session content into the folded change.
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

						// 2. Generate a conventional-commit subject from the folded diff,
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
						const maxAttempts =
							cfg.subGenerator?.retry?.maxAttempts ?? 3;
						const timeoutMs = cfg.subGenerator?.timeoutMs ?? 30_000;
						const model =
							cfg.subGeneratorModel ?? "openai/gpt-4o-mini";
						const subject = await generateManualHeader(
							diff,
							resolveSpawnFn(),
							{ model, maxAttempts, timeoutMs },
						);
						debug.event("fold_header", { subject });

						// 3. Describe the folded change with the generated subject.
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

						// 4. Archive the session as a practical convenience: forget the
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
