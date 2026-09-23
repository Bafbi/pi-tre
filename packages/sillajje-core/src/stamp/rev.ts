/**
 * Rev stamp path — describe any jj-resolvable revision with a generated
 * conventional-commit header plus provenance metadata.
 *
 * A Rev stamp is bound to a revision, not to a session: it never moves a
 * bookmark, never runs `jj new`, and never touches session state. A single
 * `jj describe` is one jj operation, so the path is atomic by construction.
 */

import { emitStatus } from "../action.js";
import { buildDiffOnlyBody } from "./diff-only.js";
import { describeRevision } from "./internal.js";
import type { StampDeps, StampResult } from "./types.js";

/**
 * Execute the Rev stamp path: generate a header from `jj diff -r <rev>`,
 * describe the change, and nothing else.
 *
 * Errors report faithfully: an unresolvable or immutable rev relays jj's
 * own stderr; an empty diff at the rev returns `no-changes` before any
 * mutation; sub-generator exhaustion keeps its `header-fallback` warning
 * through the status sink.
 */
export async function stampRevPath(
	wsPath: string,
	rev: string,
	deps: StampDeps,
): Promise<StampResult> {
	const built = await buildDiffOnlyBody(deps, wsPath, rev, {
		source: "rev",
		rev,
	});
	if (!built.ok) {
		return built;
	}

	// Phase: sealing-change — a single `jj describe`, atomic by construction.
	emitStatus(deps.onStatus, { kind: "phase", code: "sealing-change" });

	return describeRevision(deps, wsPath, rev, built.body, built.subject);
}
