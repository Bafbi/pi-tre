/**
 * Stamp module — self-contained engine for stamping jj Changes.
 *
 * Two-layer seam. Layer 1 (session link) is the function name:
 * - `stampSession(input, deps)` — bound to a sillajje session, always seals
 *   its `@` (update-stale → describe → bookmark set → jj new).
 * - `stampRev(input, deps)` — bound to a revision, describes the change and
 *   nothing else.
 *
 * Layer 2 (context) is `interaction` presence on `stampSession`'s input:
 * with a transcript the message generates from interaction + diff; without
 * one, from the diff alone. Rev stamps never carry transcripts.
 *
 * Public API:
 * - `stampSession(input, deps)` — the Session stamp entry point
 * - `stampRev(input, deps)` — the Rev stamp entry point
 * - `setSessionBookmark(exec, sessionKey, wsPath)` — for before_agent_start reuse
 *
 * Types: `SessionStampInput`, `RevStampInput`, `StampDeps`, `StampStatus`,
 * `StampResult`, `StampEnv`
 */

import type {
	RevStampInput,
	SessionStampInput,
	StampDeps,
	StampResult,
} from "./types.js";

/**
 * Stamp the session's working copy from an Interaction or from the diff
 * alone.
 *
 * With `input.interaction` (the pending transcript) the header and trace
 * generate from interaction + diff; without one the message generates from
 * the diff alone. Both seal the session's `@`.
 *
 * Statuses stream through the injected `onStatus` sink during execution.
 * Expected failures are returned as `ok: false` values — the module never
 * throws for them.
 */
export async function stampSession(
	input: SessionStampInput,
	deps: StampDeps,
): Promise<StampResult> {
	const { stampSession: session } = await import("./session.js");
	return session(input, deps);
}

/**
 * Stamp any jj-resolvable revision with a generated diff-only header plus
 * provenance metadata. A Rev stamp is bound to a revision, not to a session:
 * it describes the change and nothing else — no bookmark, no `jj new`, no
 * update-stale, and no session state of any kind.
 *
 * Statuses stream through the injected `onStatus` sink during execution.
 * Expected failures are returned as `ok: false` values — the module never
 * throws for them.
 */
export async function stampRev(
	input: RevStampInput,
	deps: StampDeps,
): Promise<StampResult> {
	const { stampRev: run } = await import("./rev.js");
	return run(input, deps);
}

// Re-exports
export { setSessionBookmark } from "./bookmark.js";
export type {
	RevStampInput,
	SessionStampInput,
	StampDeps,
	StampEnv,
	StampResult,
	StampStatus,
} from "./types.js";
