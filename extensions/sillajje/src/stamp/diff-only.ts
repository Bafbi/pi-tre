/**
 * Shared diff-only message generation — the shape used by both diff-only
 * stamp contexts: the Session stamp without a transcript and the Rev stamp.
 *
 * Fetches the diff, generates a conventional-commit header, renders the
 * provenance block, and assembles the commit body. The caller supplies the
 * provenance facts and performs its own seal step on the result
 * (`sealWorkingCopy` for a session, `describeRevision` for a rev).
 */

import {
	buildCommitBody,
	renderMetadata,
	type StampTrigger,
} from "../metadata.js";
import { generateManualHeader } from "../sub-generator.js";
import { emit } from "./internal.js";
import type { StampConfig, StampDeps } from "./types.js";

/** Provenance facts the caller derives from the call crossing the seam. */
export interface DiffOnlyFacts {
	trigger: StampTrigger;
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
	cfg: StampConfig,
	jjDir: string,
	rev: string,
	facts: DiffOnlyFacts,
): Promise<DiffOnlyBody> {
	emit({ kind: "phase", code: "collecting-diff" }, deps);

	let diff: string;
	try {
		const diffResult = await deps.exec("jj", ["diff", "-r", rev], {
			cwd: jjDir,
		});
		if (diffResult.code !== 0) {
			// An unresolvable or immutable rev is jj's call to explain —
			// relay its stderr rather than reading the failure as empty.
			emit(
				{
					kind: "error",
					code: "diff_fetch_failed",
					message: `jj diff -r ${rev} failed (exit ${diffResult.code}): ${diffResult.stderr}`,
				},
				deps,
			);
			return { ok: false, reason: "failed" };
		}
		diff = diffResult.stdout;
	} catch (err) {
		emit(
			{
				kind: "error",
				code: "diff_fetch_failed",
				message: `jj diff failed: ${String(err)}`,
			},
			deps,
		);
		return { ok: false, reason: "failed" };
	}

	if (!diff || diff.trim().length === 0) {
		return { ok: false, reason: "no-changes" };
	}

	emit({ kind: "phase", code: "generating-header" }, deps);

	const { text: subject, fellBack } = await generateManualHeader(
		diff,
		deps.spawn,
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
		emit(
			{
				kind: "warning",
				code: "header-fallback",
				message:
					"commit subject generation failed — sub-generator exhausted retries",
			},
			deps,
		);
	}

	const metadata = renderMetadata({
		enabled: cfg.metaEnabled,
		model: cfg.model,
		fallbacks: fellBack ? ["header"] : [],
		env: deps.env,
		facts,
	});
	const body = buildCommitBody({
		subject,
		trace: "",
		prompt: "",
		metadata,
		response: "",
	});

	return { ok: true, body, subject };
}
