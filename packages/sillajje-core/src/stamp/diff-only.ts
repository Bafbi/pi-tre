/**
 * Shared diff-only message generation — the shape used by both diff-only
 * stamp contexts: the Session stamp without a transcript and the Rev stamp.
 *
 * Fetches the diff, generates a conventional-commit header, renders the
 * provenance block, and assembles the commit body. The caller supplies the
 * provenance facts and performs its own seal step on the result
 * (`sealWorkingCopy` for a session, `describeRevision` for a rev).
 */

import { emitStatus } from "../action.js";
import { buildCommitBody, buildMeta, type StampSource } from "../metadata.js";
import { generateManualHeader } from "../sub-generator.js";
import { queryFailureDetail } from "./internal.js";
import type { StampDeps } from "./types.js";

/** Provenance facts the caller derives from the call crossing the seam. */
export interface DiffOnlyFacts {
	source: StampSource;
	/** Stamped session's key (Session stamp without a transcript). */
	sessionKey?: string;
	/** Target rev (Rev stamp). */
	rev?: string;
}

/** The assembled diff-only commit body, ready for the caller's seal step. */
export type DiffOnlyBody =
	| { ok: true; body: string; subject: string }
	| { ok: false; reason: "no-changes" | "failed" };

/**
 * Generate the diff-only commit body from `jj diff -r <rev>`.
 *
 * The diff is the primary input of this path. jj explains its own
 * failures: a non-zero exit relays stderr (unresolvable rev, immutable
 * target, corrupt workspace) instead of reading as empty, and only a
 * genuinely empty diff returns `no-changes` — before any mutation.
 */
export async function buildDiffOnlyBody(
	deps: StampDeps,
	jjDir: string,
	rev: string,
	facts: DiffOnlyFacts,
): Promise<DiffOnlyBody> {
	const cfg = deps.cfg;
	emitStatus(deps.onStatus, { kind: "phase", code: "collecting-diff" });

	let diff: string;
	try {
		diff = await deps.jj.diff(rev, { cwd: jjDir });
	} catch (err) {
		// An unresolvable or immutable rev is jj's call to explain —
		// relay its stderr rather than reading the failure as empty.
		emitStatus(deps.onStatus, {
			kind: "error",
			code: "diff_fetch_failed",
			message: `jj diff -r ${rev} ${queryFailureDetail(err)}`,
		});
		return { ok: false, reason: "failed" };
	}

	if (!diff || diff.trim().length === 0) {
		return { ok: false, reason: "no-changes" };
	}

	emitStatus(deps.onStatus, { kind: "phase", code: "generating-header" });

	const { text: subject, fellBack } = await generateManualHeader(
		diff,
		deps.run,
		{
			model: cfg.model,
			maxAttempts: cfg.maxAttempts,
			timeoutMs: cfg.timeoutMs,
		},
	);

	// Emit a warning only when the sub-generator actually exhausted its
	// retries (signalled by the fallback flag, not by comparing against the
	// fallback literal).
	if (fellBack) {
		emitStatus(deps.onStatus, {
			kind: "warning",
			code: "header-fallback",
			message:
				"commit subject generation failed — sub-generator exhausted retries",
		});
	}

	const metadata = buildMeta({
		source: facts.source,
		sessionKey: facts.sessionKey,
		rev: facts.rev,
		model: cfg.model,
		fallbacks: fellBack ? ["header"] : [],
		env: deps.env,
	});
	const body = buildCommitBody(
		{
			subject,
			trace: "",
			prompt: "",
			metadata,
			loop: "",
			response: "",
		},
		cfg.body,
	);

	return { ok: true, body, subject };
}
