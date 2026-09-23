/**
 * The sync action.
 *
 * `createSync(ports)` brings a revision into a session's ancestry as a merge,
 * keeping the session's own history intact. It is a single `jj rebase`, so it
 * does not open a transaction: a conflict is a designed abort, not partial
 * state, and a failed `update-stale` after a successful rebase is a warning.
 */

import { formatFailure } from "@pi-tre/sillajje-jj";
import type { CurrentSession } from "@pi-tre/sillajje-workspace";
import {
	type Action,
	emitStatus,
	type JjPort,
	type StatusPort,
	type WorkspacePort,
} from "./action.js";
import type { CommandHelp, CommandSpec, SessionFailure } from "./args.js";

/** The sync input. */
export interface SyncInput {
	/** The session to sync: a session key, a session id, or `@` for the caller's. */
	target: string;
	/** The caller's live session, for the current-session exemption. */
	current?: CurrentSession;
	/** The revision to bring into the session's ancestry. */
	rev: string;
}

/** The sync outcome. Conflicts carry the files for the adapter to render. */
export type SyncResult =
	| { ok: true; rev: string; sessionKey: string }
	| {
			ok: false;
			reason: "failed" | "conflict" | SessionFailure;
			files?: string[];
	  };

/**
 * Bind the sync action's ports and return the action. It needs no config, no
 * versions, and no sub-generator: a jj-only host can build it.
 */
export function createSync(
	ports: JjPort & WorkspacePort & StatusPort,
): Action<SyncInput, SyncResult> {
	const { jj, workspaces, onStatus } = ports;

	return async (input) => {
		// `@` names the caller's session; resolveTarget answers the rest.
		const target =
			input.target === "@"
				? (input.current?.sessionKey ?? input.target)
				: input.target;
		const resolved = await workspaces.resolveTarget(
			target,
			input.current ?? {},
		);
		if (!resolved.ok) return { ok: false, reason: resolved.reason };

		const { sessionKey, wsPath } = resolved;
		emitStatus(onStatus, { kind: "phase", code: "rebasing" });

		// One `jj rebase` with two `--onto` flags: the target revision and the
		// session's bookmark. The bookmark parent keeps the session's history
		// attached; the target joins the ancestry as a second parent.
		const rebased = await jj.apply(
			{
				kind: "rebase",
				source: "@",
				onto: [input.rev, workspaces.bookmarkName(sessionKey)],
			},
			{ cwd: wsPath },
		);
		if (!rebased.ok) {
			emitStatus(onStatus, {
				kind: "error",
				code: "rebase_failed",
				message: `sync failed: ${formatFailure(rebased.error)}`,
			});
			return { ok: false, reason: "failed" };
		}

		// File-level conflicts are a designed abort: list them and leave the
		// merge for the user.
		const conflicts = await jj.conflicts(undefined, { cwd: wsPath });
		if (conflicts.length > 0) {
			emitStatus(onStatus, {
				kind: "warning",
				code: "conflict",
				message: `sync produced file-level conflicts — resolve them manually:\n${conflicts.join("\n")}`,
			});
			return { ok: false, reason: "conflict", files: conflicts };
		}

		// A failed sync after a successful rebase is a non-fatal warning: the
		// session did sync.
		try {
			await jj.workspaceUpdateStale({ cwd: wsPath });
		} catch (err) {
			emitStatus(onStatus, {
				kind: "warning",
				code: "update_stale_failed",
				message: `jj workspace update-stale failed: ${String(err)}`,
			});
		}

		return { ok: true, rev: input.rev, sessionKey };
	};
}

/** The sync subcommand — bring a revision into a session's ancestry. */
export const SYNC_ARGS: CommandSpec = {
	name: "sync",
	usage: "sync [-s|--session <id>] -o|--onto <rev>",
	flags: [
		{ key: "session", aliases: ["-s", "--session"], takesValue: true },
		{ key: "onto", aliases: ["-o", "--onto"], takesValue: true },
	],
	required: ["onto"],
};

/** The sync subcommand's help. */
export const SYNC_HELP: CommandHelp = {
	usage: SYNC_ARGS.usage,
	lines: [
		"Brings a revision into a session's ancestry as a merge, keeping the session's history.",
		"  -s, --session <id>  the session to sync; @ means this session (default)",
		"  -o, --onto <rev>    the revision to merge into the session's ancestry (required)",
		"  -h, --help          show this help",
	],
};
