/**
 * Shared three-state session target resolution.
 *
 * The stamp, rebase, and fold subcommands all answer the same questions
 * about a target sillajje session, so they share one resolver: no
 * `sillajje/<key>` bookmark → not a sillajje session; bookmark without a
 * workspace → archived; both → active, proceed.
 */

import {
	bookmarkExists,
	type ExecFn,
	getWorkspacePathByName,
	workspaceName,
} from "./workspace.js";

export type SessionTargetResolution =
	| { ok: true; sessionKey: string; wsPath: string }
	| { ok: false; reason: "not-a-session" | "archived" };

/**
 * Resolve a target sillajje session to its workspace.
 *
 * The current session's stored workspace path is used directly; any other
 * target is looked up from `jj workspace list`. A target with neither
 * workspace nor bookmark is not a sillajje session; a target with a
 * bookmark but no workspace is archived.
 */
export async function resolveSessionTarget(
	exec: ExecFn,
	repoRoot: string,
	targetSessionKey: string,
	current: { sessionKey?: string; wsPath?: string },
): Promise<SessionTargetResolution> {
	let wsPath: string | undefined;
	if (targetSessionKey === current.sessionKey && current.wsPath) {
		wsPath = current.wsPath;
	} else {
		wsPath = await getWorkspacePathByName(
			exec,
			workspaceName(targetSessionKey),
		);
	}

	if (!wsPath) {
		const hasBookmark = await bookmarkExists(
			exec,
			`sillajje/${targetSessionKey}`,
			repoRoot,
		);
		if (!hasBookmark) return { ok: false, reason: "not-a-session" };
		return { ok: false, reason: "archived" };
	}

	return { ok: true, sessionKey: targetSessionKey, wsPath };
}
