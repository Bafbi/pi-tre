/**
 * Session stamp — bound to a sillajje session, always seals its `@`.
 *
 * With a transcript the message generates from interaction + diff (the
 * agent_end auto-stamp); without one it generates from the diff alone (the
 * manual `/sillajje stamp`). Whether a stamp seals is decided by which
 * entry point the adapter calls, never by a rev string.
 */

import { buildDiffOnlyBody } from "./diff-only.js";
import { stampInteractionPath } from "./interaction.js";
import { emit, getStampConfig, sealWorkingCopy } from "./internal.js";
import type { SessionStampInput, StampDeps, StampResult } from "./types.js";

/**
 * Execute the Session stamp: generate the commit body, then the full seal
 * (update-stale → describe → bookmark set → jj new).
 */
export async function stampSession(
	input: SessionStampInput,
	deps: StampDeps,
): Promise<StampResult> {
	const cfg = getStampConfig(deps.config);
	const { wsPath, sessionKey } = input.workspace;

	if (input.interaction !== undefined) {
		return stampInteractionPath(
			input.workspace,
			input.interaction,
			deps,
			cfg,
		);
	}

	// Manual context: the message generates from the diff alone.
	try {
		const built = await buildDiffOnlyBody(deps, cfg, wsPath, "@", {
			trigger: "manual-session",
			sessionKey,
		});
		if (!built.ok) {
			return built;
		}

		emit({ kind: "phase", code: "sealing-change" }, deps);

		return await sealWorkingCopy(
			deps,
			wsPath,
			sessionKey,
			built.body,
			built.subject,
		);
	} catch (err) {
		emit(
			{
				kind: "error",
				code: "unexpected_error",
				message: `stamp failed: ${String(err)}`,
			},
			deps,
		);
		return { ok: false, reason: "failed" };
	}
}
