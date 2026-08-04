/**
 * Diff stamp path.
 *
 * Fetches the diff at the target revision, returns `no-changes` when empty,
 * generates a classic conventional-commit header, and describes the change.
 */

import { generateManualHeader } from "../sub-generator.js";
import { sessionBookmark } from "./bookmark.js";
import { describeRevision, emit, sealWorkingCopy } from "./internal.js";
import type {
	StampConfig,
	StampDeps,
	StampInput,
	StampResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// stampDiff — the Diff stamp path
// ---------------------------------------------------------------------------

/**
 * Execute the Diff stamp path.
 */
export async function stampDiff(
	input: StampInput,
	deps: StampDeps,
	cfg: StampConfig,
): Promise<StampResult> {
	const { wsPath, sessionKey } = input.workspace;
	const rev = input.rev ?? "@";

	// Phase: collecting-diff
	emit({ kind: "phase", code: "collecting-diff" }, deps);

	// The diff is the primary input of this path. A non-zero exit reads as an
	// empty diff (no-changes); a rejected fetch is a real failure and must not
	// be confused with no-changes.
	let diff: string;
	try {
		const diffResult = await deps.exec("jj", ["diff", "-r", rev], {
			cwd: wsPath,
		});
		diff = diffResult.code === 0 ? diffResult.stdout : "";
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

	// Phase: generating-header
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

	// Emit a warning only when the sub-generator actually exhausted its retries
	// (signalled by the fallback flag, not by comparing against the fallback
	// literal).
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

	const metaLine = `Meta: ${sessionBookmark(sessionKey)}`;
	const body = `${subject}\n\n${metaLine}`;

	// Phase: sealing-change
	emit({ kind: "phase", code: "sealing-change" }, deps);

	try {
		if (rev === "@") {
			return await sealWorkingCopy(
				deps,
				wsPath,
				sessionKey,
				body,
				subject,
			);
		}
		return await describeRevision(deps, wsPath, rev, body, subject);
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
