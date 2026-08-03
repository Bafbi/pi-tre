/**
 * Stamp module — self-contained engine for sealing Interactions and diffs into
 * jj Changes. Single entry point: `stamp(input, deps)`.
 *
 * Public API:
 * - `stamp(input, deps)` — the main entry point
 * - `setSessionBookmark(exec, sessionKey, wsPath)` — for before_agent_start reuse
 * - `deriveInteractionData(messages)` — derives data from pi's Message[]
 * - `extractAssistantText(msg)` — extracts text from assistant content blocks
 *
 * Types: `StampInput`, `StampDeps`, `StampStatus`, `StampResult`
 */

import { getStampConfig } from "./stamp/internal.js";
import type {
	StampConfig,
	StampDeps,
	StampInput,
	StampResult,
} from "./stamp/types.js";

/**
 * Stamp a jj Change from an Interaction or a Diff.
 *
 * When `input.interaction` is a `Message[]` transcript, the Interaction stamp
 * path executes. When `input.interaction` is `null`, the Diff stamp path executes.
 *
 * Statuses stream through the injected `onStatus` sink during execution.
 * Expected failures are returned as `ok: false` values — the module never throws
 * for them.
 */
export async function stamp(
	input: StampInput,
	deps: StampDeps,
): Promise<StampResult> {
	const cfg = getStampConfig(deps.config);

	if (input.interaction !== null) {
		const { stampInteraction } = await import("./stamp/interaction.js");
		return stampInteraction(input, deps, cfg);
	}
	const { stampDiff } = await import("./stamp/diff.js");
	return stampDiff(input, deps, cfg);
}

// Re-exports
export { setSessionBookmark } from "./stamp/bookmark.js";
export { deriveInteractionData, extractAssistantText } from "./stamp/derive.js";
export type {
	StampDeps,
	StampInput,
	StampResult,
	StampStatus,
} from "./stamp/types.js";
