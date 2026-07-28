import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDebugLogger } from "./debug-log.js";
import { buildCommitBody, buildMetadata, deriveSubject } from "./metadata.js";
import { redirect } from "./path-redirect.js";
import { SessionState } from "./state.js";
import { formatPill } from "./status-pill.js";
import {
	cleanupWorkspace,
	createWorkspace,
	type ExecFn,
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

/** Default workspaces root directory. */
const DEFAULT_WORKSPACES_ROOT = `${homedir()}/.pi/sillajje`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the concatenated text from an AssistantMessage's content blocks.
 * Filters to only `text` blocks and joins with newlines.
 */
function extractAssistantText(msg: {
	role: string;
	content: Array<{ type: string; text?: string }>;
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
	let debug = createDebugLogger();

	debug.event("extension_loaded");

	// Wrap pi.exec as an ExecFn adapter for the workspace module.
	const exec: ExecFn = (command, args, options) =>
		pi.exec(command, args, options);

	// Helper: sync the footer status pill to current state.
	const syncPill = (ctx: {
		hasUI: boolean;
		ui: { setStatus: (key: string, text: string | undefined) => void };
	}) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("sillajje", formatPill(state));
	};

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

		// Re-create the logger with the detected repo root so project-level
		// config (.pi/configs/sillajje.json) takes effect.
		debug = createDebugLogger(repoRoot);

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
					DEFAULT_WORKSPACES_ROOT,
				);
				state.setWorkspacePath(info.workspacePath);
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

	pi.on("before_agent_start", async (event, _ctx) => {
		debug.event("before_agent_start", { promptLen: event.prompt.length });
		if (state.isInactive()) {
			debug.event("before_agent_start_skip", { reason: "inactive" });
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

		if (!state.hasNewInteraction()) {
			debug.event("stamp_skip", { reason: "no_new_interaction" });
			return;
		}

		const snapshot = state.getInteractionData(sessionId);
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
		const subject = deriveSubject(prompt);
		const metadata = buildMetadata(snapshot);
		const response = state.getInteractionResponse() ?? "";
		const body = buildCommitBody({ subject, prompt, metadata, response });

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

			// 3. Seal the current working copy and start a fresh one on top.
			//    This ensures each interaction is a separate change in `jj log`.
			const newResult = await pi.exec(
				"jj",
				["new", "-m", `sillajje: continue ${sessionId}`],
				{ cwd: wsPath },
			);
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

	pi.on("agent_end", async (event, ctx) => {
		debug.event("agent_end", { messageCount: event.messages.length });
		if (state.isInactive()) return undefined;

		// Find the last assistant message and extract its text.
		const assistantMsgs = event.messages.filter(
			(m) => (m as { role: string }).role === "assistant",
		);
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

	pi.on("tool_call", async (event, _ctx) => {
		debug.event("tool_call", { toolName: event.toolName });
		if (state.isInactive()) return undefined;

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
	// session_shutdown — clean up unused workspaces
	// -----------------------------------------------------------------------

	pi.on("session_shutdown", async (_event, ctx) => {
		if (state.isInactive() || state.isArchived()) return;

		const wsPath = state.getWorkspacePath();
		const sessionId = state.getSessionId();
		if (!wsPath || !sessionId) return;

		if (!state.hasUserPrompted()) {
			await cleanupWorkspace(exec, wsName(sessionId), wsPath);
			syncPill(ctx);
		}
	});

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
					if (ctx.hasUI) {
						ctx.ui.notify(
							"[sillajje] archive not yet implemented",
							"warning",
						);
					}
					break;
				}

				case "unarchive": {
					if (ctx.hasUI) {
						ctx.ui.notify(
							"[sillajje] unarchive not yet implemented",
							"warning",
						);
					}
					break;
				}

				default: {
					if (ctx.hasUI) {
						ctx.ui.notify(
							"Usage: /sillajje [status|archive|unarchive]",
							"warning",
						);
					}
					break;
				}
			}
		},
	});
}
