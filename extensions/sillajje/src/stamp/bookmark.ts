/**
 * setSessionBookmark — point the session bookmark at the working copy.
 *
 * Exported so `before_agent_start` reuses the same `ExecFn` path for the
 * initial bookmark creation.
 */

import type { ExecFn } from "../workspace.js";

/**
 * Point the `sillajje/<sessionKey>` bookmark at the workspace's current
 * working copy (`@`).
 */
export async function setSessionBookmark(
	exec: ExecFn,
	sessionKey: string,
	wsPath: string,
): Promise<void> {
	await exec("jj", ["bookmark", "set", `sillajje/${sessionKey}`, "-r", "@"], {
		cwd: wsPath,
	});
}
