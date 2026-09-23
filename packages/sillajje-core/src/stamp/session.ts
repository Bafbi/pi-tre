/**
 * Session stamp — bound to a sillajje session, always seals its `@`.
 *
 * With derived interaction data the message generates from interaction + diff
 * (the `agent_end` auto-stamp); without it the message generates from the diff
 * alone (the manual stamp). Whether a stamp seals is decided by
 * which action the adapter calls, never by a rev string.
 */

import { emitStatus } from "../action.js";
import { buildDiffOnlyBody } from "./diff-only.js";
import { stampInteractionPath } from "./interaction.js";
import { sealWorkingCopy } from "./internal.js";
import type { InteractionData, StampDeps, StampResult } from "./types.js";

/**
 * Execute the Session stamp: generate the commit body, then the full seal
 * (update-stale → describe → bookmark set → jj new).
 */
export async function stampSessionPath(
	workspace: { sessionKey: string; wsPath: string },
	interaction: InteractionData | undefined,
	deps: StampDeps,
): Promise<StampResult> {
	const { wsPath, sessionKey } = workspace;

	if (interaction !== undefined) {
		return stampInteractionPath(workspace, interaction, deps);
	}

	// Manual context: the message generates from the diff alone.
	try {
		const built = await buildDiffOnlyBody(deps, wsPath, "@", {
			source: "diff",
			sessionKey,
		});
		if (!built.ok) {
			return built;
		}

		emitStatus(deps.onStatus, { kind: "phase", code: "sealing-change" });

		return await sealWorkingCopy(
			deps,
			wsPath,
			sessionKey,
			built.body,
			built.subject,
		);
	} catch (err) {
		emitStatus(deps.onStatus, {
			kind: "error",
			code: "unexpected_error",
			message: `stamp failed: ${String(err)}`,
		});
		return { ok: false, reason: "failed" };
	}
}
