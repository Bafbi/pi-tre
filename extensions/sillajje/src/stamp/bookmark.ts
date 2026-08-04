/**
 * setSessionBookmark — point the session bookmark at the working copy.
 *
 * Exported so `before_agent_start` reuses the same `ExecFn` path for the
 * initial bookmark creation.
 */

import type { ExecFn } from "../workspace.js";

/**
 * The session's bookmark name: `sillajje/<sessionKey>`.
 *
 * The bookmark is the stable handle on session work — jj show, revsets, and
 * the Meta line all resolve through it — so the name is made in one place.
 */
export function sessionBookmark(sessionKey: string): string {
	return `sillajje/${sessionKey}`;
}

/**
 * Point the `sillajje/<sessionKey>` bookmark at the workspace's current
 * working copy (`@`).
 */
export async function setSessionBookmark(
	exec: ExecFn,
	sessionKey: string,
	wsPath: string,
): Promise<void> {
	await exec(
		"jj",
		["bookmark", "set", sessionBookmark(sessionKey), "-r", "@"],
		{ cwd: wsPath },
	);
}
