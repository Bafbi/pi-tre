/**
 * The session bookmark.
 *
 * The bookmark is the stable handle on session work — jj show, revsets, and
 * the Meta line all resolve through it. Its name comes from the workspace
 * boundary's `bookmarkName`, the one authority for `sillajje/<session-key>`.
 * `createSetSessionBookmark` points it at a session's working copy; the
 * adapter calls it on `before_agent_start` so the ref exists from the first
 * interaction.
 */

import type { CurrentSession } from "@pi-tre/sillajje-workspace";
import type { Action, JjPort, StatusPort, WorkspacePort } from "../action.js";

/** Input for setting a session's bookmark. */
export interface SetSessionBookmarkInput {
	/** The session to book mark: a key, id, or `@`. */
	target: string;
	/** The caller's live session, for the current-session exemption. */
	current?: CurrentSession;
}

/**
 * Point the `sillajje/<session-key>` bookmark at the working copy's `@`.
 *
 * Returns `true` when the bookmark was set. A non-zero `jj bookmark set`
 * exit returns `false` — an expected failure surfaced as a value, matching
 * the stamp action's error policy. Callers must not continue as if the
 * bookmark was created when `false` is returned.
 */
export function createSetSessionBookmark(
	ports: JjPort & WorkspacePort & StatusPort,
): Action<SetSessionBookmarkInput, boolean> {
	return async ({ target, current }) => {
		const resolved = await ports.workspaces.resolveTarget(
			target,
			current ?? {},
		);
		if (!resolved.ok) {
			ports.onStatus({
				kind: "error",
				code: "bookmark_set_failed",
				message: `cannot resolve session target ${target}: ${resolved.reason}`,
			});
			return false;
		}

		const result = await ports.jj.apply(
			{
				kind: "bookmarkSet",
				name: ports.workspaces.bookmarkName(resolved.sessionKey),
				rev: "@",
			},
			{ cwd: resolved.wsPath },
		);
		return result.ok;
	};
}
