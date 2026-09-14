/**
 * Shared three-state session target resolution.
 *
 * The stamp, rebase, and fold subcommands all answer the same questions
 * about a target sillajje session, so they share one resolver. The current
 * session is trusted and exempt from the bookmark check; every other target
 * is validated by the three-state rule: no `sillajje/<key>` bookmark → not a
 * sillajje session; bookmark without a workspace → archived; both → active,
 * proceed.
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
 * The current session is trusted: when the target key matches the caller's
 * stored session key and a workspace path is stored, that path is returned
 * without a bookmark check. The workspace name carries the session id, so a
 * stale or reused path is not a realistic target. Any other target is looked
 * up from `jj workspace list` and validated by the three-state rule: no
 * `sillajje/<key>` bookmark is not a sillajje session; a bookmark without a
 * workspace is archived.
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
