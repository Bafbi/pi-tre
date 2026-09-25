import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	ARCHIVE_ARGS,
	ARCHIVE_HELP,
	type ArgValue,
	type CommandHelp,
	type CommandSpec,
	createArchive,
	createFold,
	createSetSessionBookmark,
	createStamp,
	createSync,
	createUnarchive,
	FOLD_ARGS,
	FOLD_HELP,
	type ProvenanceVersions,
	parseCommandArgs,
	type RunSubagent,
	renderHelp,
	renderSessionFailure,
	STAMP_ARGS,
	STAMP_HELP,
	type StatusEvent,
	SYNC_ARGS,
	SYNC_HELP,
	UNARCHIVE_ARGS,
	UNARCHIVE_HELP,
} from "@pi-tre/sillajje-core";
import {
	createJj,
	type ExecFn,
	type Jj,
	VALIDATED_JJ_SERIES,
} from "@pi-tre/sillajje-jj";
import {
	createWorkspaces,
	defaultOwner,
	directoryExists,
} from "@pi-tre/sillajje-workspace";
import { loadSillajjeConfig } from "./config.js";
import { createDebugLogger } from "./debug-log.js";
import {
	lastStampMarkerId,
	projectInteraction,
	STAMP_MARKER_TYPE,
} from "./interaction.js";
import { redirect } from "./path-redirect.js";
import {
	lastSessionBase,
	NEW_ARGS,
	NEW_HELP,
	SESSION_BASE_TYPE,
	type SessionBaseMarker,
} from "./session-base.js";
import { SessionState } from "./state.js";
import { formatPill } from "./status-pill.js";
import { createRunSubagent } from "./sub-generator.js";
import { piVersion, sillajjeVersion } from "./versions.js";

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
 * Check whether jj is on PATH by reading its version through the facade.
 * Returns `true` when the binary is present and executable.
 */
async function isJjOnPath(jj: Jj): Promise<boolean> {
	try {
		await jj.version();
		return true;
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
 * @internal The adapter's single test-injection hook.
 *
 * The jiti extension loader imports with `moduleCache: false`, so a test's
 * module instance is not the loaded one. A test installs port overrides on
 * one `globalThis` object through `setTestPorts`; the loaded adapter reads
 * them. `run` replaces the sub-generator backend; `exec` wraps every jj call
 * so a test can inject a failure at one command. No second seam exists.
 */
interface TestPortOverrides {
	run?: RunSubagent;
	exec?: ExecFn;
}

/** The shared override object, created on first access. */
function testPorts(): TestPortOverrides {
	const g = globalThis as Record<string, unknown>;
	const existing = g.__sillajje_test_ports__;
	if (existing === undefined) {
		const fresh: TestPortOverrides = {};
		g.__sillajje_test_ports__ = fresh;
		return fresh;
	}
	return existing as TestPortOverrides;
}

/** Install test port overrides. A key set to `undefined` clears it. */
export function setTestPorts(overrides: TestPortOverrides): void {
	Object.assign(testPorts(), overrides);
}

/** The sub-generator backend: the test override or the real factory. */
function resolveRunSubagent(): RunSubagent {
	return testPorts().run ?? createRunSubagent();
}

/**
 * The ExecFn for jj calls: `pi.exec`, routed through the test override when
 * one is installed. The override is looked up per call, so a test can install
 * it after activation.
 */
function resolveExecFn(pi: ExtensionAPI): ExecFn {
	const real: ExecFn = (command, args, options) =>
		pi.exec(command, args, options);
	return (command, args, options) => {
		const override = testPorts().exec;
		return override
			? override(command, args, options)
			: real(command, args, options);
	};
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

	// Versions for the stamp provenance block — read once at activation.
	const env: ProvenanceVersions = {
		piVersion: piVersion(),
		sillajjeVersion: sillajjeVersion(),
	};

	// Wrap pi.exec as an ExecFn adapter for the workspace module. The test
	// wrapper (when installed) sees every jj call and delegates to the real
	// exec.
	const exec: ExecFn = resolveExecFn(pi);

	// One facade for the whole activation. Callers name typed Mutations; the
	// facade owns argv, transaction chaining, and parsing.
	const jj: Jj = createJj(exec);

	// Session owner (user/host), fixed for the process lifetime.
	const owner = defaultOwner();

	// The workspace binding for a repo. Rebuilt per call; the owner and the
	// workspaces root are read here so the adapter passes values in.
	const workspacesFor = (repoRoot: string) =>
		createWorkspaces(jj, {
			repoRoot,
			workspacesRoot:
				activeConfig?.workspacesRoot ?? `${homedir()}/.pi/sillajje`,
			owner,
		});

	// -------------------------------------------------------------------
	// setSessionBookmark — point the session bookmark at the working copy
	// -------------------------------------------------------------------

	/**
	 * Point the `sillajje/<session-key>` bookmark at the workspace's current
	 * working copy (`@`). The bookmark is the stable handle on session work:
	 * `jj show`, `jj diff -r 'sillajje/<id>'`, unarchive, and bookmarkExists
	 * all resolve through it, so it must exist from the first interaction.
	 *
	 * Failures are logged (event + error) but never propagated — a failed
	 * bookmark set is non-fatal (the stamp flow retries on the next
	 * interaction).
	 */
	const setSessionBookmark = async (sessionKey: string, wsPath: string) => {
		try {
			const action = createSetSessionBookmark({
				jj,
				workspaces: workspacesFor(state.getRepoRoot() ?? wsPath),
				onStatus: (event) => {
					if (event.kind === "warning" || event.kind === "error") {
						debug.error(
							`stamp_${event.kind}_${event.code}`,
							new Error(event.message),
						);
					}
				},
			});
			// The current-session exemption resolves the target to the stored
			// workspace without a jj read: the adapter already knows the path.
			const ok = await action({
				target: sessionKey,
				current: { sessionKey, wsPath },
			});
			if (!ok) {
				debug.error(
					"bookmark_set_failed",
					new Error("jj bookmark set failed"),
				);
			}
		} catch (err) {
			debug.error("bookmark_set_failed", err);
		}
	};

	// -------------------------------------------------------------------
	// createStatusSink — shared status→notification mapping for all actions
	// -------------------------------------------------------------------

	/**
	 * Build the `onStatus` sink every action shares: it maps status events to
	 * debug logs and UI notifications, so one policy serves stamp, sync, and
	 * fold.
	 */
	const createStatusSink = (ctx: {
		hasUI: boolean;
		ui: {
			notify: (msg: string, type: "info" | "warning" | "error") => void;
		};
	}) => {
		return (s: StatusEvent) => {
			if (s.kind === "phase") {
				debug.event(`action_phase_${s.code}`, {});
			} else if (s.kind === "info") {
				debug.event(`action_info_${s.code}`, { message: s.message });
				if (ctx.hasUI) {
					ctx.ui.notify(`[sillajje] ${s.message}`, "info");
				}
			} else if (s.kind === "warning") {
				debug.error(`action_warning_${s.code}`, new Error(s.message));
				if (ctx.hasUI) {
					ctx.ui.notify(`[sillajje] ${s.message}`, "warning");
				}
			} else if (s.kind === "error") {
				debug.error(`action_error_${s.code}`, new Error(s.message));
				if (ctx.hasUI) {
					ctx.ui.notify(`[sillajje] ${s.message}`, "error");
				}
			}
		};
	};

	type CommandContext = {
		hasUI: boolean;
		ui: {
			notify: (msg: string, type: "info" | "warning" | "error") => void;
		};
	};

	/**
	 * Bind the ports once per call from the current session state. Every action
	 * factory takes the intersection it needs from this bundle, so port
	 * construction lives in one place.
	 */
	const buildPorts = (ctx: CommandContext, repoRoot?: string) => {
		const root =
			repoRoot ?? state.getRepoRoot() ?? state.getWorkspacePath() ?? ".";
		return {
			jj,
			workspaces: workspacesFor(root),
			config: activeConfig ?? loadSillajjeConfig(),
			versions: env,
			run: resolveRunSubagent(),
			onStatus: createStatusSink(ctx),
		};
	};

	/**
	 * Build the stamp action for a context: bind the ports it needs, then call
	 * `session` or `rev`. The optional `repoRoot` lets a caller that resolved a
	 * repo from `ctx.cwd` (the inactive-session path) feed the same root to the
	 * `Workspaces` port; the current-session exemption keeps jj out of the
	 * common path.
	 */
	const buildStamp = (ctx: CommandContext, repoRoot?: string) =>
		createStamp(buildPorts(ctx, repoRoot));

	/**
	 * The command spelling the adapter owns. The core renders the usage line
	 * relative to this, so no pi command name lives in the core. Each command
	 * receives only its own arguments, so the parser does not skip a token.
	 */
	const commandPrefix = "/sillajje:";

	/**
	 * Apply the session default: a subcommand that accepts `-s <id>` reads a
	 * bare invocation as `-s @` when a sillajje session exists. Outside a
	 * session the bare form stays a help request, so the parser's usage line
	 * is the answer instead of a session-target error.
	 */
	const sessionDefault = (args: string): string =>
		args.trim() === "" && state.getSessionKey() !== undefined
			? "-s @"
			: args;

	/**
	 * Parse a subcommand's args against its spec. On a usage error or a help
	 * request, report through the UI and return `undefined` so the caller
	 * breaks. One home for the parser→notification policy stamp, sync, and
	 * fold share.
	 */
	const parseOrReport = (
		ctx: CommandContext,
		args: string,
		spec: CommandSpec,
		help: CommandHelp,
		eventPrefix: string,
	): Record<string, ArgValue> | undefined => {
		const parsed = parseCommandArgs(args, spec, { prefix: commandPrefix });
		if (parsed.kind === "error") {
			debug.event(`${eventPrefix}_usage_error`, {
				error: parsed.message,
			});
			if (ctx.hasUI) {
				ctx.ui.notify(`[sillajje] ${parsed.message}`, "warning");
			}
			return undefined;
		}
		if (parsed.kind === "help") {
			debug.event(`${eventPrefix}_help`);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] ${renderHelp(help, commandPrefix)}`,
					"info",
				);
			}
			return undefined;
		}
		return parsed.values;
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
				// `postInit` is an operator-authored shell command from trusted
				// project config, so a shell is the feature. The repo's
				// `no-shell-c` ast-grep rule flags this call as a reminder.
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
	// Missing-workspace detection — workspace deleted or jj disappeared mid-session
	// -----------------------------------------------------------------------

	/** Whether an active session's workspace directory no longer exists on disk. */
	const isWorkspaceGone = (): boolean => {
		const wsPath = state.getWorkspacePath();
		return state.isActive() && !!wsPath && !directoryExists(wsPath);
	};

	/**
	 * Mark the session as a missing workspace and notify the user once (deduped by isMissingWorkspace).
	 * A session with a missing workspace cannot stamp or redirect tools safely — the user must
	 * unarchive or start a new session.
	 */
	const markMissingWorkspaceAndNotify = (
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
		if (state.isMissingWorkspace()) return;
		state.markMissingWorkspace();
		debug.error("session_missing_workspace", new Error(reason));
		if (ctx.hasUI) {
			ctx.ui.notify(
				`[sillajje] ${reason} — session marked unusable. Use /sillajje:unarchive or start a new session.`,
				"error",
			);
		}
	};

	/** Block reason shown to the agent when the session's workspace is missing. */
	const missingWorkspaceBlockReason =
		"The sillajje workspace for this session is missing or unusable. " +
		"Tell the user to run /sillajje:unarchive or start a new session.";

	// -----------------------------------------------------------------------
	// session_start — detect jj, determine state
	// -----------------------------------------------------------------------

	// The cursor is the last Stamp marker on the branch. Rebuild it on load and
	// after tree navigation, so a reload or a fork resumes there.
	const syncCursor = (ctx: ExtensionContext, reason?: string) => {
		const marker = lastStampMarkerId(ctx.sessionManager.getBranch());
		if (marker !== null) {
			state.setCursorId(marker);
			return;
		}
		// No Stamp marker. On a reload, leave the cursor null so an in-flight
		// Interaction is recovered. Otherwise baseline to the current leaf so a
		// resumed session does not re-stamp its history.
		state.setCursorId(
			reason === "reload" ? null : ctx.sessionManager.getLeafId(),
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		debug.event("session_start", { mode: ctx.mode, reason: _event.reason });
		state.reset();
		syncCursor(ctx, _event.reason);

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

		// Version check: warn once when the host's jj is outside the list this
		// build was validated against. The typed parse failures are the guard;
		// this warning is the heads-up.
		let jjAvailable = false;
		try {
			const check = await jj.checkVersion();
			jjAvailable = true;
			env.jjVersion =
				check.status === "unrecognised" ? check.raw : check.version.raw;
			if (check.status !== "validated" && ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] jj ${env.jjVersion} is not in the validated list (${VALIDATED_JJ_SERIES.join(", ")}) — output parsing may fail; please report`,
					"warning",
				);
			}
		} catch {
			jjAvailable = false;
		}
		const repoRoot = jjAvailable ? findJjRepoRoot(ctx.cwd) : undefined;

		debug.event("jj_detection", { jjAvailable, repoRoot, cwd: ctx.cwd });

		state.setDetection(jjAvailable, repoRoot);

		// Load sillajje config (project `<repo>/.pi/configs/sillajje.json` or
		// global `~/.pi/agent/configs/sillajje.json`). Used for debug logging,
		// workspace root, and sub-generator model.
		activeConfig = loadSillajjeConfig({
			repoRoot,
			trusted: ctx.isProjectTrusted(),
		});
		debug = createDebugLogger({ enabled: activeConfig.debug ?? false });

		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId !== undefined) {
			state.setSessionId(sessionId);
		}

		if (state.isActive() && repoRoot && sessionId) {
			// A `/sillajje:new` invocation records the base it chose in the new
			// session's log (see session-base.ts); a plain /new has none.
			const baseMarker = lastSessionBase(ctx.sessionManager.getBranch());
			debug.event("creating_workspace", {
				repoRoot,
				sessionId,
				base: baseMarker?.base,
			});
			try {
				const workspaces = workspacesFor(repoRoot);
				const result = await workspaces.ensure(
					sessionId,
					baseMarker === undefined
						? undefined
						: { base: baseMarker.base },
				);

				// An archived session is never rebuilt here; the user must
				// unarchive it, which resumes from the session bookmark.
				if (!result.ok) {
					state.setSessionKey(workspaces.sessionKey(sessionId));
					state.setArchived();
					syncPill(ctx);
					if (ctx.hasUI) {
						ctx.ui.notify(
							`[sillajje] ${renderSessionFailure(result.reason, sessionId)}`,
							"warning",
						);
					}
					return;
				}

				const info = result.workspace;
				state.setWorkspacePath(info.workspacePath);
				state.setSessionKey(info.sessionKey);

				// Run post-init commands (non-fatal — session activates regardless).
				await runPostInit(ctx);

				debug.event("workspace_ready", {
					path: info.workspacePath,
					status: result.status,
				});
				syncPill(ctx);

				if (ctx.hasUI) {
					ctx.ui.notify(
						`[sillajje] workspace ready at ${info.workspacePath}`,
						"info",
					);
					if (result.status === "created" && result.fromRoot) {
						ctx.ui.notify(
							baseMarker === undefined
								? '[sillajje] trunk() resolves to root(): the session workspace is an empty tree. Set revset-aliases."trunk()" to a bookmark.'
								: `[sillajje] base ${baseMarker.label} resolves to root(): the session workspace is an empty tree.`,
							"warning",
						);
					}
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
	// session_tree — reconstruct the Interaction cursor on branch navigation
	// -----------------------------------------------------------------------

	pi.on("session_tree", async (_event, ctx) => {
		syncCursor(ctx);
	});

	// -----------------------------------------------------------------------
	// before_agent_start — inject workspace path + create session bookmark
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
		if (state.isMissingWorkspace()) return undefined;
		if (isWorkspaceGone()) {
			markMissingWorkspaceAndNotify(
				ctx,
				"workspace directory no longer exists",
			);
			return undefined;
		}

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

		const workspaceLines = [
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
		];

		// `vcsGuard` (default on) reserves VCS commands for the user. An
		// unrequested jj command can move bookmarks or rewrite history, which
		// breaks the session's stamp chain.
		if (activeConfig?.vcsGuard ?? true) {
			workspaceLines.push(
				"",
				"Sillajje owns the session's jj state. Ask the user before you run any",
				"jj or git command. An unrequested command can move bookmarks or",
				"rewrite history.",
			);
		}

		workspaceLines.push("");
		const workspaceBlock = workspaceLines.join("\n");

		return {
			systemPrompt: event.systemPrompt + workspaceBlock,
		};
	});

	// -----------------------------------------------------------------------
	// markStamped — write the Stamp marker and advance the cursor
	// -----------------------------------------------------------------------

	/** Write the Stamp marker and advance the cursor to it. */
	const markStamped = (ctx: ExtensionContext, rev: string | null) => {
		pi.appendEntry(STAMP_MARKER_TYPE, { rev });
		state.setCursorId(ctx.sessionManager.getLeafId());
	};

	// -----------------------------------------------------------------------
	// stampPending — project the pending Interaction and stamp it
	// -----------------------------------------------------------------------

	const stampPending = async (ctx: ExtensionContext) => {
		const sessionId = state.getSessionId();
		const wsPath = state.getWorkspacePath();
		if (!sessionId || !wsPath) {
			debug.event("stamp_skip", { reason: "no_session_or_ws" });
			return;
		}

		const sessionKey = state.getSessionKey() ?? sessionId;
		const projected = projectInteraction(
			ctx.sessionManager.getBranch(),
			state.getCursorId(),
		);
		if (!projected) {
			debug.event("stamp_skip", { reason: "no_interaction" });
			return;
		}

		debug.event("stamp_change", {
			firstEntryId: projected.range?.first,
			lastEntryId: projected.range?.last,
		});

		const result = await buildStamp(ctx).session({
			target: sessionKey,
			current: { sessionKey, wsPath },
			interaction: projected,
		});

		if (result.ok) {
			debug.event("stamp_done", {
				subject: result.subject,
				rev: result.rev,
			});
		} else if (result.reason === "failed") {
			// The stamp action emits an error status before returning `failed`,
			// and createStatusSink notifies the user on every error status — the
			// sink is the single notification point for stamp failures.
			debug.error("stamp_failed", new Error("stamp returned failed"));
		}

		// Advance the Stamp marker whether the stamp succeeded, failed, or
		// found no changes, so the next Interaction starts after it.
		markStamped(ctx, result.ok ? result.rev : null);
	};

	// -----------------------------------------------------------------------
	// stampManual — /sillajje:stamp command
	// -----------------------------------------------------------------------

	const stampManual = async (ctx: ExtensionContext) => {
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

		const result = await buildStamp(ctx).session({
			target: sessionKey,
			current: { sessionKey, wsPath },
		});

		if (result.ok) {
			debug.event("stamp_manual_done", {
				subject: result.subject,
				rev: result.rev,
			});
			// A manual stamp consumes the pending Interaction: write a Stamp
			// marker so the next auto-stamp starts after it.
			markStamped(ctx, result.rev);
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
			// The stamp action emits an error status before returning `failed`,
			// and createStatusSink notifies the user on every error status — the
			// sink is the single notification point for stamp failures.
			debug.error(
				"stamp_manual_failed",
				new Error("stamp returned failed"),
			);
		}
	};

	// -----------------------------------------------------------------------
	// agent_settled — the true end of a run; stamp the pending Interaction
	// -----------------------------------------------------------------------

	pi.on("agent_settled", async (_event, ctx) => {
		debug.event("agent_settled");
		if (state.isInactive()) return;

		// Missing workspace (deleted, or jj gone): don't stamp.
		if (state.isMissingWorkspace()) return;
		if (isWorkspaceGone()) {
			markMissingWorkspaceAndNotify(
				ctx,
				"workspace directory no longer exists",
			);
			return;
		}
		if (!(await isJjOnPath(jj))) {
			markMissingWorkspaceAndNotify(ctx, "jj is no longer on PATH");
			return;
		}

		await stampPending(ctx);
	});

	// -----------------------------------------------------------------------
	// tool_call — redirect paths + record tool usage
	// -----------------------------------------------------------------------

	pi.on("tool_call", async (event, ctx) => {
		debug.event("tool_call", { toolName: event.toolName });
		if (state.isInactive()) return undefined;

		// Missing workspace — block tools so nothing writes to the real repo.
		if (state.isMissingWorkspace()) {
			return { block: true, reason: missingWorkspaceBlockReason };
		}
		if (isWorkspaceGone()) {
			markMissingWorkspaceAndNotify(
				ctx,
				"workspace directory no longer exists",
			);
			return { block: true, reason: missingWorkspaceBlockReason };
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

		// The old space form (`/sillajje stamp`) is retired. Catch it first so a
		// stale command neither reaches the model nor triggers a pending stamp.
		// The match is narrow: a colon command is left alone, and an unknown
		// colon subcommand falls through to pi's ordinary behavior.
		if (/^\/sillajje(?:\s|$)/.test(event.text)) {
			const subcommand = event.text.trim().split(/\s+/)[1];
			const known = [
				"status",
				"new",
				"stamp",
				"archive",
				"unarchive",
				"sync",
				"fold",
			].includes(subcommand ?? "");
			const suggestion = known
				? `/sillajje:${subcommand}`
				: "/sillajje:<status|new|stamp|archive|unarchive|sync|fold>";
			debug.event("input_old_form_guard", { text: event.text });
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] "/sillajje ..." is retired — use "${suggestion}"`,
					"warning",
				);
			}
			return { action: "handled" as const };
		}

		state.markPrompted();

		if (state.isInactive()) return undefined;
		if (state.isMissingWorkspace()) {
			// Already notified when the missing workspace was detected — prompts pass
			// through so the user can still run /sillajje: commands.
			return undefined;
		}
		if (state.isArchived()) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"[sillajje] This session is archived. Use /sillajje:unarchive to resume.",
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

		if (state.isMissingWorkspace()) return undefined;
		if (isWorkspaceGone()) {
			markMissingWorkspaceAndNotify(
				ctx,
				"workspace directory no longer exists",
			);
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
		if (
			state.isInactive() ||
			state.isArchived() ||
			state.isMissingWorkspace()
		)
			return;

		const repoRoot = state.getRepoRoot();
		const wsPath = state.getWorkspacePath();
		const sessionId = state.getSessionId();
		if (!repoRoot || !wsPath || !sessionId) return;

		// Flush a completed but unstamped Interaction so its work is not left
		// un-stamped in the working copy.
		await stampPending(ctx);

		if (!state.hasUserPrompted()) {
			const workspaces = workspacesFor(repoRoot);
			await workspaces.archive(
				workspaces.sessionKey(state.getSessionKey() ?? sessionId),
			);
			syncPill(ctx);
		}
	});

	// -----------------------------------------------------------------------
	// Command handlers — one named function per subcommand
	// -----------------------------------------------------------------------

	const handleStatus = async (
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		const lifecycle = state.getLifecycle();
		const lines: string[] = [`Sillajje session status: ${lifecycle}`];

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
		return;
	};

	const handleArchive = async (
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		const values = parseOrReport(
			ctx,
			sessionDefault(args),
			ARCHIVE_ARGS,
			ARCHIVE_HELP,
			"archive",
		);
		if (values === undefined) return;

		const target =
			typeof values.session === "string" ? values.session : "@";

		const repoRoot = state.getRepoRoot();
		if (!repoRoot) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"[sillajje] cannot archive: no jj repo detected",
					"error",
				);
			}
			return;
		}

		const ports = buildPorts(ctx, repoRoot);
		const result = await createArchive(ports)({
			target,
			current: {
				sessionKey: state.getSessionKey(),
				wsPath: state.getWorkspacePath(),
			},
		});
		if (!result.ok) {
			// The action already emitted the error status.
			debug.error("archive_failed", new Error(result.message));
			return;
		}

		debug.event("session_archived", {
			sessionKey: result.sessionKey,
			outcome: result.status,
		});

		// Update state if this is the current session.
		if (result.sessionKey === state.getSessionKey()) {
			state.setArchived();
			state.clearWorkspacePath();
			state.setCursorId(null);
		}

		syncPill(ctx);

		if (ctx.hasUI) {
			const label = ports.workspaces.unqualified(result.sessionKey);
			ctx.ui.notify(
				result.status === "removed"
					? `[sillajje] session ${label} archived`
					: `[sillajje] session ${label} archived (workspace already gone)`,
				"info",
			);
		}
		return;
	};

	const handleStamp = async (
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		const values = parseOrReport(
			ctx,
			sessionDefault(args),
			STAMP_ARGS,
			STAMP_HELP,
			"stamp",
		);
		if (values === undefined) return;

		const rev = values.rev;
		const sessionId = values.session;
		if (typeof rev === "string") {
			// Rev stamp: describe the target change and nothing else.
			// Works with or without a live sillajje session — jj runs
			// from the current session's workspace when one is active,
			// otherwise from the repo root.
			const activeWsPath =
				state.isActive() && !state.isMissingWorkspace()
					? state.getWorkspacePath()
					: undefined;
			const wsPath =
				activeWsPath ?? state.getRepoRoot() ?? findJjRepoRoot(ctx.cwd);
			if (!wsPath) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"[sillajje] cannot stamp: no jj repo detected",
						"error",
					);
				}
				return;
			}

			debug.event("stamp_rev_start", {
				rev,
				wsPath,
			});

			// A Rev stamp runs in a working directory, not a session: the
			// adapter resolved it above (active workspace or repo root).
			// Side-effect scope: a Rev stamp touches no session state —
			// the pending interaction survives and still auto-stamps.
			const revResult = await buildStamp(ctx).rev({
				cwd: wsPath,
				rev,
			});

			if (revResult.ok) {
				debug.event("stamp_rev_done", {
					subject: revResult.subject,
					rev: revResult.rev,
				});
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[sillajje] change ${rev} stamped: ${revResult.subject}`,
						"info",
					);
				}
			} else if (revResult.reason === "no-changes") {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[sillajje] nothing to stamp at ${rev} — no changes`,
						"info",
					);
				}
			} else {
				// The stamp action emits an error status before returning
				// `failed`; createStatusSink already notified the user.
				debug.error(
					"stamp_rev_failed",
					new Error("stamp rev returned failed"),
				);
			}
			return;
		}

		if (typeof sessionId === "string") {
			if (sessionId === "@") {
				// `-s @` targets the current session: today's bare
				// `/sillajje:stamp` behavior.
				await stampManual(ctx);
				syncPill(ctx);
				return;
			}

			// Cross-session stamp: a Session stamp on another
			// sillajje session's @, resolved and validated with
			// the same three-state check sync and fold use.
			const repoRoot = state.getRepoRoot() ?? findJjRepoRoot(ctx.cwd);
			if (!repoRoot) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"[sillajje] cannot stamp: no jj repo detected",
						"error",
					);
				}
				return;
			}

			// The action resolves the target through the Workspaces
			// port. The adapter still needs the session key for its own
			// bookkeeping; the pure `sessionKey` method gives it without a
			// jj read.
			const workspaces = workspacesFor(repoRoot);
			const targetKey = workspaces.sessionKey(sessionId);

			// The foreign transcript is never borrowed: a session
			// stamp on another session generates from the diff
			// alone. Stamping the current session keeps today's
			// state resets (it covers any pending interaction).
			const stampingCurrent = targetKey === state.getSessionKey();

			debug.event("stamp_session_start", {
				sessionKey: targetKey,
				stampingCurrent,
			});

			const sessionResult = await buildStamp(ctx, repoRoot).session({
				target: sessionId,
				current: {
					sessionKey: state.getSessionKey(),
					wsPath: state.getWorkspacePath(),
				},
			});

			if (sessionResult.ok) {
				debug.event("stamp_session_done", {
					subject: sessionResult.subject,
					sessionKey: targetKey,
				});
				if (stampingCurrent) {
					// Sealing the working copy covers the pending
					// Interaction — advance the Stamp marker.
					markStamped(ctx, sessionResult.rev);
				}
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[sillajje] session ${targetKey} stamped: ${sessionResult.subject}`,
						"info",
					);
				}
				if (stampingCurrent) {
					syncPill(ctx);
				}
			} else if (sessionResult.reason === "no-changes") {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[sillajje] nothing to stamp at session ${targetKey} — no changes`,
						"info",
					);
				}
			} else if (sessionResult.reason === "failed") {
				// The stamp action emits an error status before
				// returning `failed`; createStatusSink already
				// notified the user.
				debug.error(
					"stamp_session_failed",
					new Error("stamp session returned failed"),
				);
			} else {
				// A session target the port could not resolve: render the
				// same three-state message sync and fold use.
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[sillajje] ${renderSessionFailure(sessionResult.reason, sessionId)}`,
						"error",
					);
				}
			}
			return;
		}

		return;
	};

	const handleUnarchive = async (
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		const values = parseOrReport(
			ctx,
			sessionDefault(args),
			UNARCHIVE_ARGS,
			UNARCHIVE_HELP,
			"unarchive",
		);
		if (values === undefined) return;

		const target =
			typeof values.session === "string" ? values.session : "@";

		const repoRoot = state.getRepoRoot();
		if (!repoRoot) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"[sillajje] cannot unarchive: no jj repo detected",
					"error",
				);
			}
			return;
		}

		const ports = buildPorts(ctx, repoRoot);
		const result = await createUnarchive(ports)({
			target,
			current: {
				sessionKey: state.getSessionKey(),
				wsPath: state.getWorkspacePath(),
			},
		});
		if (!result.ok) {
			if (result.reason === "failed") {
				// The action already emitted the error status.
				debug.error("unarchive_failed", new Error(result.message));
			} else if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] ${renderSessionFailure(result.reason, target)}`,
					"error",
				);
			}
			return;
		}

		// Restore state for the unarchived session.
		state.setSessionId(result.sessionId);
		state.setSessionKey(result.workspace.sessionKey);
		state.setActive();
		state.setWorkspacePath(result.workspace.workspacePath);
		// Archive cleared the cursor. Rebuild it from the last Stamp marker,
		// or the next stamp projects the whole branch and re-includes the
		// prompts and responses of already-stamped Interactions.
		syncCursor(ctx);
		debug.event("session_unarchived", {
			sessionKey: result.sessionKey,
			path: result.workspace.workspacePath,
		});
		syncPill(ctx);

		if (ctx.hasUI) {
			ctx.ui.notify(
				`[sillajje] workspace restored at ${result.workspace.workspacePath}`,
				"info",
			);
		}
		return;
	};

	// -----------------------------------------------------------------------
	// new — start a session whose workspace branches from a chosen base
	// -----------------------------------------------------------------------

	/**
	 * Resolve the Base a `/sillajje:new` invocation names to an immutable commit
	 * id or a session bookmark, and label it for messages. Returns undefined
	 * after reporting a failure.
	 */
	const resolveNewBase = async (
		ctx: CommandContext,
		onto: string | undefined,
		ontoSession: string | undefined,
		repoRoot: string,
	): Promise<SessionBaseMarker | undefined> => {
		if (ontoSession !== undefined) {
			const target =
				ontoSession === "@" ? state.getSessionKey() : ontoSession;
			if (target === undefined) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"[sillajje] no sillajje session to resolve @ — use -s <id>",
						"error",
					);
				}
				return undefined;
			}
			const source = await workspacesFor(repoRoot)
				.resolveBaseSource(target)
				.catch((err) => {
					debug.error("new_base_resolve_failed", err);
					if (ctx.hasUI) {
						ctx.ui.notify(
							`[sillajje] cannot resolve session ${target}: ${String(err)}`,
							"error",
						);
					}
					return undefined;
				});
			if (source === undefined) return undefined;
			if (!source.ok) {
				const reason =
					source.reason === "ambiguous"
						? `session ${target}'s bookmark is conflicted — resolve it in jj first`
						: renderSessionFailure(source.reason, target);
				if (ctx.hasUI) {
					ctx.ui.notify(`[sillajje] ${reason}`, "error");
				}
				return undefined;
			}
			return { base: source.revision, label: ontoSession };
		}

		if (onto !== undefined) {
			// `@` resolves in the current workspace, so it needs a live one. A
			// named revision resolves there too, else in the repo root.
			const wsPath =
				state.isActive() && !state.isMissingWorkspace()
					? state.getWorkspacePath()
					: undefined;
			if (onto === "@" && wsPath === undefined) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"[sillajje] no sillajje session to resolve @ — use -o <rev>",
						"error",
					);
				}
				return undefined;
			}
			try {
				// Resolve now, in the caller's workspace: `@` must capture the
				// current working copy, not the main checkout's `@`.
				const [tip] = await jj.log(onto, { cwd: wsPath ?? repoRoot });
				if (tip === undefined) {
					if (ctx.hasUI) {
						ctx.ui.notify(
							`[sillajje] revision ${onto} did not resolve in jj`,
							"error",
						);
					}
					return undefined;
				}
				return { base: tip.commitId, label: onto };
			} catch (err) {
				debug.error("new_base_resolve_failed", err);
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[sillajje] cannot resolve ${onto}: ${String(err)}`,
						"error",
					);
				}
				return undefined;
			}
		}

		return undefined;
	};

	/** Open a new pi session, recording the base for its `session_start`. */
	const startNewSession = async (
		ctx: ExtensionCommandContext,
		marker: SessionBaseMarker,
	): Promise<void> => {
		const result = await ctx.newSession({
			setup: async (sm) => {
				sm.appendCustomEntry(SESSION_BASE_TYPE, {
					base: marker.base,
					label: marker.label,
				} satisfies SessionBaseMarker);
			},
		});
		if (result.cancelled) {
			debug.event("new_session_cancelled", {});
			if (ctx.hasUI) {
				ctx.ui.notify("[sillajje] new session cancelled", "info");
			}
			return;
		}
		debug.event("new_session", {
			base: marker.base,
			label: marker.label,
		});
		if (ctx.hasUI) {
			ctx.ui.notify(
				`[sillajje] starting a new session on ${marker.label}`,
				"info",
			);
		}
	};

	const handleNew = async (
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		// A bare `/sillajje:new` continues from this session's last seal
		// (`-s @`) when a session exists. The shared parser treats zero tokens
		// as a help request, so the default is supplied here.
		const values = parseOrReport(
			ctx,
			sessionDefault(args),
			NEW_ARGS,
			NEW_HELP,
			"new",
		);
		if (values === undefined) return;

		const onto = typeof values.onto === "string" ? values.onto : undefined;
		const ontoSession =
			typeof values["onto-session"] === "string"
				? values["onto-session"]
				: undefined;

		const repoRoot = state.getRepoRoot() ?? findJjRepoRoot(ctx.cwd);
		if (!repoRoot) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"[sillajje] cannot start a session: no jj repo detected",
					"error",
				);
			}
			return;
		}

		const base = await resolveNewBase(ctx, onto, ontoSession, repoRoot);
		if (base === undefined) return;

		await startNewSession(ctx, base);
	};

	const handleSync = async (
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		const values = parseOrReport(ctx, args, SYNC_ARGS, SYNC_HELP, "sync");
		if (values === undefined) return;

		const rev = values.onto;
		if (typeof rev !== "string") return;
		const session =
			typeof values.session === "string" ? values.session : "@";

		const repoRoot = state.getRepoRoot() ?? findJjRepoRoot(ctx.cwd);
		if (!repoRoot) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"[sillajje] cannot sync: no jj repo detected",
					"error",
				);
			}
			return;
		}

		const sync = createSync(buildPorts(ctx, repoRoot));
		const result = await sync({
			target: session,
			current: {
				sessionKey: state.getSessionKey(),
				wsPath: state.getWorkspacePath(),
			},
			rev,
		});

		if (result.ok) {
			// The session stays active after a successful sync.
			debug.event("sync_done", {
				sessionKey: result.sessionKey,
				rev: result.rev,
			});
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] session ${result.sessionKey} synced onto ${result.rev}`,
					"info",
				);
			}
		} else if (result.reason === "failed" || result.reason === "conflict") {
			// The action emitted an error or conflict status; the sink
			// already notified the user.
			debug.error(
				`sync_${result.reason}`,
				new Error("sync returned a failure"),
			);
		} else {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] ${renderSessionFailure(result.reason, session)}`,
					"error",
				);
			}
		}
		return;
	};

	const handleFold = async (
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		const values = parseOrReport(ctx, args, FOLD_ARGS, FOLD_HELP, "fold");
		if (values === undefined) return;

		const onto = typeof values.onto === "string" ? values.onto : undefined;
		const session =
			typeof values.session === "string" ? values.session : undefined;
		const rev = typeof values.rev === "string" ? values.rev : undefined;
		const name = typeof values.name === "string" ? values.name : undefined;
		const update =
			typeof values.update === "string" ? values.update : undefined;
		const land = values.land === true;
		const archive = values.archive === true;

		const repoRoot = state.getRepoRoot() ?? findJjRepoRoot(ctx.cwd);
		if (!repoRoot) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"[sillajje] cannot fold: no jj repo detected",
					"error",
				);
			}
			return;
		}

		debug.event("fold_start", { session, rev, onto, update, name });
		const fold = createFold(buildPorts(ctx, repoRoot));
		const result = await fold({
			session,
			rev,
			onto,
			update,
			name,
			land,
			archive,
			current: {
				sessionKey: state.getSessionKey(),
				wsPath: state.getWorkspacePath(),
			},
			cwd: repoRoot,
		});

		const targetLabel = update ?? onto ?? "the target";
		if (result.ok) {
			debug.event("fold_done", {
				rev: result.rev,
				ref: result.ref,
				bookmark: result.bookmark,
			});
			// Archiving the current session is an adapter-side state change:
			// the action archived the workspace, the adapter owns the session.
			if (
				result.archived &&
				result.sessionKey === state.getSessionKey()
			) {
				state.setArchived();
				state.clearWorkspacePath();
				state.setCursorId(null);
				syncPill(ctx);
			}
			if (ctx.hasUI) {
				const named =
					result.bookmark !== undefined &&
					result.bookmark !== targetLabel
						? ` (named ${result.bookmark})`
						: "";
				ctx.ui.notify(
					`[sillajje] folded onto ${targetLabel} as ${result.rev}: ${result.subject}${named}`,
					"info",
				);
			}
		} else if (result.reason === "no-changes") {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] nothing to fold onto ${targetLabel} — no new changes`,
					"info",
				);
			}
		} else if (result.reason === "usage") {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] ${result.message ?? "invalid fold arguments"}`,
					"warning",
				);
			}
		} else if (result.reason === "failed" || result.reason === "conflict") {
			// The action emitted an error or conflict status; the sink
			// already notified the user.
			debug.error(
				`fold_${result.reason}`,
				new Error("fold returned a failure"),
			);
		} else {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`[sillajje] ${renderSessionFailure(result.reason, session ?? "@")}`,
					"error",
				);
			}
		}
		return;
	};

	// -----------------------------------------------------------------------
	// /sillajje:<subcommand> commands
	// -----------------------------------------------------------------------

	pi.registerCommand("sillajje:status", {
		description: "Report the sillajje session status",
		handler: async (_args, ctx) => {
			await handleStatus(ctx);
		},
	});

	pi.registerCommand("sillajje:stamp", {
		description: "Stamp a change with a generated commit message",
		handler: async (args, ctx) => {
			await handleStamp(args, ctx);
		},
	});

	pi.registerCommand("sillajje:archive", {
		description: "Archive the current session workspace",
		handler: async (args, ctx) => {
			await handleArchive(args, ctx);
		},
	});

	pi.registerCommand("sillajje:unarchive", {
		description: "Recreate an archived session workspace",
		handler: async (args, ctx) => {
			await handleUnarchive(args, ctx);
		},
	});

	pi.registerCommand("sillajje:new", {
		description: "Start a new session from a chosen base, not trunk()",
		handler: async (args, ctx) => {
			await handleNew(args, ctx);
		},
	});

	pi.registerCommand("sillajje:sync", {
		description: "Bring a revision into a session's ancestry",
		handler: async (args, ctx) => {
			await handleSync(args, ctx);
		},
	});

	pi.registerCommand("sillajje:fold", {
		description: "Publish a source range as one clean change",
		handler: async (args, ctx) => {
			await handleFold(args, ctx);
		},
	});
}
