/**
 * The stamp action.
 *
 * `createStamp(ports)` binds the ports and returns the two stamp actions:
 *
 * - `session(input)` — bound to a session, always seals its `@`
 *   (update-stale → describe → bookmark set → jj new).
 * - `rev(input)` — bound to a revision, describes the change and nothing else.
 *
 * The context axis is `interaction` presence on the session input: with
 * derived interaction data the message generates from interaction + diff;
 * without it, from the diff alone. Rev stamps never carry interaction data.
 *
 * A session input names a session `target` that resolves through the
 * `Workspaces` port; a rev input names the working directory (`cwd`) the
 * adapter already resolved.
 *
 * Statuses stream through the bound `onStatus` sink. Expected failures are
 * returned as `ok: false` values — the action never throws for them.
 */

import type { HostPorts, SubagentPort } from "../action.js";
import { getStampConfig } from "./internal.js";
import { stampRevPath } from "./rev.js";
import { stampSessionPath } from "./session.js";
import type { StampActions, StampDeps } from "./types.js";

export function createStamp(ports: HostPorts & SubagentPort): StampActions {
	const deps: StampDeps = {
		jj: ports.jj,
		workspaces: ports.workspaces,
		run: ports.run,
		env: ports.versions,
		onStatus: ports.onStatus,
		cfg: getStampConfig(ports.config),
	};

	return {
		async session(input) {
			const resolved = await ports.workspaces.resolveTarget(
				input.target,
				input.current ?? {},
			);
			if (!resolved.ok) {
				return { ok: false, reason: resolved.reason };
			}
			return stampSessionPath(resolved, input.interaction, deps);
		},

		async rev(input) {
			return stampRevPath(input.cwd, input.rev, deps);
		},
	};
}

// Re-exports
export {
	createSetSessionBookmark,
	type SetSessionBookmarkInput,
} from "./bookmark.js";
export { getStampConfig } from "./internal.js";
export type {
	InteractionData,
	RevStampInput,
	SessionFailure,
	SessionStampInput,
	StampActions,
	StampConfig,
	StampResult,
} from "./types.js";
