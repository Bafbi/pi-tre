/**
 * Rev stamp path — describe any jj-resolvable revision with a generated
 * conventional-commit header plus provenance metadata.
 *
 * A Rev stamp is bound to a revision, not to a session: it never moves a
 * bookmark, never runs `jj new`, and never touches session state. A single
 * `jj describe` is one jj operation, so the path is atomic by construction.
 */

import { buildDiffOnlyBody } from "./diff-only.js";
import { describeRevision, emit, getStampConfig } from "./internal.js";
import type { RevStampInput, StampDeps, StampResult } from "./types.js";

/**
 * Execute the Rev stamp path: generate a header from `jj diff -r <rev>`,
 * describe the change, and nothing else.
 *
 * Errors report faithfully: an unresolvable or immutable rev relays jj's
 * own stderr; an empty diff at the rev returns `no-changes` before any
 * mutation; sub-generator exhaustion keeps its `header-fallback` warning
 * through the status sink.
 */
export async function stampRev(
	input: RevStampInput,
	deps: StampDeps,
): Promise<StampResult> {
	const cfg = getStampConfig(deps.config);
	const { wsPath, rev } = input;

	const built = await buildDiffOnlyBody(deps, cfg, wsPath, rev, {
		trigger: "rev",
		rev,
	});
	if (!built.ok) {
		return built;
	}

	// Phase: sealing-change — a single `jj describe`, atomic by construction.
	emit({ kind: "phase", code: "sealing-change" }, deps);

	return describeRevision(deps, wsPath, rev, built.body, built.subject);
}
