/**
 * The archive action family.
 *
 * `createArchive` retires a session's workspace and keeps its bookmark.
 * `createUnarchive` rebuilds that workspace from the bookmark. Both are thin
 * over the Workspaces port: the adapter owns the session-state transitions and
 * the messages that follow.
 */

import type { CurrentSession, WorkspaceInfo } from "@pi-tre/sillajje-workspace";
import {
	type Action,
	emitStatus,
	type StatusPort,
	type WorkspacePort,
} from "./action.js";
import type { CommandHelp, CommandSpec, SessionFailure } from "./args.js";

/** The archive input. */
export interface ArchiveInput {
	/** The session to archive: a session key, a session id, or `@` for the caller's. */
	target: string;
	/** The caller's live session, so `@` resolves without a jj read. */
	current?: CurrentSession;
}

/** The archive outcome. `already-gone` means the workspace directory was absent. */
export type ArchiveResult =
	| { ok: true; sessionKey: string; status: "removed" | "already-gone" }
	| { ok: false; reason: "failed"; message: string }
	| { ok: false; reason: SessionFailure };

/** The unarchive input. */
export interface UnarchiveInput {
	/** The archived session to restore: a session key, a session id, or `@`. */
	target: string;
	/** The caller's live session, so `@` resolves without a jj read. */
	current?: CurrentSession;
}

/** The unarchive outcome. */
export type UnarchiveResult =
	| {
			ok: true;
			sessionKey: string;
			sessionId: string;
			workspace: WorkspaceInfo;
	  }
	| { ok: false; reason: "failed"; message: string }
	| { ok: false; reason: "active"; sessionKey: string }
	| { ok: false; reason: SessionFailure };

/**
 * Resolve `@` to the caller's session key. Every other target passes through
 * for the port to qualify.
 */
function resolveCaller(target: string, current?: CurrentSession): string {
	return target === "@" ? (current?.sessionKey ?? target) : target;
}

/**
 * Whether a session id is a single safe path segment. The port's `unqualified`
 * keeps any `/` in the id, so an id like `../../victim` would otherwise reach
 * the recursive delete as a traversal path. Reject it before any port call.
 */
function isSafeSessionId(id: string): boolean {
	return id.length > 0 && id !== "." && id !== ".." && !/[/\\]/.test(id);
}

/** Bind the archive action's ports and return the action. */
export function createArchive(
	ports: WorkspacePort & StatusPort,
): Action<ArchiveInput, ArchiveResult> {
	const { workspaces, onStatus } = ports;

	return async (input) => {
		const sessionKey = workspaces.sessionKey(
			resolveCaller(input.target, input.current),
		);
		// A malformed or foreign target must never reach the port. The id is a
		// single path segment; anything else is a traversal path.
		if (!isSafeSessionId(workspaces.unqualified(sessionKey))) {
			return { ok: false, reason: "not-a-session" };
		}
		if (workspaces.ownerOf(sessionKey) !== workspaces.owner) {
			return { ok: false, reason: "foreign" };
		}

		emitStatus(onStatus, { kind: "phase", code: "archiving" });
		try {
			const outcome = await workspaces.archive(sessionKey);
			if (outcome.status === "failed") {
				emitStatus(onStatus, {
					kind: "error",
					code: "archive_failed",
					message: `archive failed: ${outcome.reason}`,
				});
				return { ok: false, reason: "failed", message: outcome.reason };
			}

			return { ok: true, sessionKey, status: outcome.status };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			emitStatus(onStatus, {
				kind: "error",
				code: "archive_failed",
				message: `archive failed: ${message}`,
			});
			return { ok: false, reason: "failed", message };
		}
	};
}

/** Bind the unarchive action's ports and return the action. */
export function createUnarchive(
	ports: WorkspacePort & StatusPort,
): Action<UnarchiveInput, UnarchiveResult> {
	const { workspaces, onStatus } = ports;

	return async (input) => {
		const sessionKey = workspaces.sessionKey(
			resolveCaller(input.target, input.current),
		);
		// A malformed or foreign target must never reach the port.
		if (!isSafeSessionId(workspaces.unqualified(sessionKey))) {
			return { ok: false, reason: "not-a-session" };
		}
		if (workspaces.ownerOf(sessionKey) !== workspaces.owner) {
			return { ok: false, reason: "foreign" };
		}

		emitStatus(onStatus, { kind: "phase", code: "unarchiving" });
		try {
			// Unarchiving a live workspace runs `jj workspace forget` before the
			// re-add fails on the non-empty directory, leaving the workspace
			// unregistered while the session stays active. Reject a live
			// workspace, but let a registered-but-gone one rebuild.
			if (await workspaces.isLive(sessionKey)) {
				return { ok: false, reason: "active", sessionKey };
			}
			const workspace = await workspaces.unarchive(sessionKey);
			return {
				ok: true,
				sessionKey,
				sessionId: workspaces.unqualified(sessionKey),
				workspace,
			};
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			emitStatus(onStatus, {
				kind: "error",
				code: "unarchive_failed",
				message: `unarchive failed: ${message}`,
			});
			return { ok: false, reason: "failed", message };
		}
	};
}

// ---------------------------------------------------------------------------
// The archive and unarchive subcommands
// ---------------------------------------------------------------------------

/** The archive subcommand — retire a session's workspace. */
export const ARCHIVE_ARGS: CommandSpec = {
	name: "archive",
	usage: "archive [-s|--session <id>]",
	flags: [{ key: "session", aliases: ["-s", "--session"], takesValue: true }],
};

/** The archive subcommand's help. */
export const ARCHIVE_HELP: CommandHelp = {
	usage: ARCHIVE_ARGS.usage,
	lines: [
		"Archives a session: keeps its bookmark and deletes its workspace.",
		"  -s, --session <id>  the session to archive; @ means this session (default)",
		"  -h, --help          show this help",
	],
};

/** The unarchive subcommand — rebuild an archived session's workspace. */
export const UNARCHIVE_ARGS: CommandSpec = {
	name: "unarchive",
	usage: "unarchive [-s|--session <id>]",
	flags: [{ key: "session", aliases: ["-s", "--session"], takesValue: true }],
};

/** The unarchive subcommand's help. */
export const UNARCHIVE_HELP: CommandHelp = {
	usage: UNARCHIVE_ARGS.usage,
	lines: [
		"Recreates an archived session's workspace from its bookmark.",
		"  -s, --session <id>  the session to restore; @ means this session (default)",
		"  -h, --help          show this help",
	],
};
