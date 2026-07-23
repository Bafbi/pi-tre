import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { redirect } from "./path-redirect.js";
import { SessionState } from "./state.js";
import { formatPill } from "./status-pill.js";
import { createWorkspace, type ExecFn } from "./workspace.js";

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

/**
 * sillajje — Auto-versioning for Pi agent sessions on jj.
 *
 * Every agent interaction becomes a jj change, leaving a reviewable trail
 * of all work done.
 */
export default function (pi: ExtensionAPI) {
	const state = new SessionState();

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
		state.reset();

		const jjAvailable = await isJjOnPath(pi);
		const repoRoot = jjAvailable ? findJjRepoRoot(ctx.cwd) : undefined;

		state.setDetection(jjAvailable, repoRoot);

		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId !== undefined) {
			state.setSessionId(sessionId);
		}

		if (state.isActive() && repoRoot && sessionId) {
			try {
				const info = await createWorkspace(
					exec,
					repoRoot,
					sessionId,
					DEFAULT_WORKSPACES_ROOT,
				);
				state.setWorkspacePath(info.workspacePath);
				syncPill(ctx);

				if (ctx.hasUI) {
					ctx.ui.notify(
						`[sillajje] workspace ready at ${info.workspacePath}`,
						"info",
					);
				}
			} catch (err) {
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
	// before_agent_start — no-op for issue 01 (prompt injection in issue 02)
	// -----------------------------------------------------------------------

	pi.on("before_agent_start", async (event, _ctx) => {
		if (state.isInactive()) return undefined;

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
	// agent_settled — no-op for issue 01 (change stamping in issue 04)
	// -----------------------------------------------------------------------

	pi.on("agent_settled", async (_event, _ctx) => {
		if (state.isInactive()) return undefined;
		return undefined;
	});

	// -----------------------------------------------------------------------
	// tool_call — no-op for issue 01 (path redirection in issue 03)
	// -----------------------------------------------------------------------

	pi.on("tool_call", async (event, _ctx) => {
		if (state.isInactive()) return undefined;
		// Path redirection will be wired in issue 03.
		redirect(event, state.getWorkspacePath() ?? "");
		return undefined;
	});

	// -----------------------------------------------------------------------
	// input — block archived sessions (issue 06), pass-through otherwise
	// -----------------------------------------------------------------------

	pi.on("input", async (_event, ctx) => {
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
