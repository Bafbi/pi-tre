/**
 * Internal helpers shared across the stamp sub-modules.
 */

import {
	formatFailure,
	type Jj,
	JjError,
	type JjFailure,
	type Mutation,
} from "@pi-tre/sillajje-jj";
import { emitStatus } from "../action.js";
import { type SillajjeConfig, subGeneratorDefaults } from "../config.js";
import { LOOP_FIELDS, STAMP_BODY_SECTIONS } from "../metadata.js";
import type { StampConfig, StampDeps } from "./types.js";

// ---------------------------------------------------------------------------
// Config extraction
// ---------------------------------------------------------------------------

/**
 * Extract stamping options from the fully-populated SillajjeConfig.
 * The sync-drift between schema defaults and these extraction defaults
 * is pinned by unit tests against `Default(SillajjeConfigSchema, {})`.
 */
export function getStampConfig(cfg: SillajjeConfig): StampConfig {
	const stamp = cfg.actions?.stamp;
	const generator = subGeneratorDefaults(cfg);
	return {
		body: stamp?.body ?? STAMP_BODY_SECTIONS,
		headerMode: stamp?.header?.mode ?? "one_line",
		traceDetail: stamp?.trace?.detail ?? "high",
		loopFields: stamp?.loop ?? LOOP_FIELDS,
		...generator,
	};
}

// ---------------------------------------------------------------------------
// jj failure detail
// ---------------------------------------------------------------------------

/**
 * The failure detail a `jj <verb>` status message carries: jj's own stderr
 * when it was a query failure, the thrown error's text otherwise.
 */
export function queryFailureDetail(err: unknown): string {
	return err instanceof JjError && err.failure.kind === "query"
		? `failed (exit ${err.failure.exitCode}): ${err.failure.stderr}`
		: `failed: ${String(err)}`;
}

// ---------------------------------------------------------------------------
// jj seal sequence — a deferred-integration transaction
// ---------------------------------------------------------------------------

/** The status code a failed seal step reports. */
function sealStepCode(
	mutation: Mutation,
): "describe_failed" | "bookmark_set_failed" | "jj_new_failed" | "seal_failed" {
	switch (mutation.kind) {
		case "describe":
			return "describe_failed";
		case "bookmarkSet":
			return "bookmark_set_failed";
		case "new":
			return "jj_new_failed";
		default:
			return "seal_failed";
	}
}

/**
 * Map a transaction failure to the seal's status stream.
 *
 * A failed rollback is a warning, not a second error: the primary failure is
 * what the user acts on, and the dangling operations stay inert. An integrate
 * failure carries the operation id, so `jj op integrate <id>` is the
 * documented recovery.
 */
function emitSealFailure(failure: JjFailure, deps: StampDeps): void {
	if (
		(failure.kind === "command" ||
			failure.kind === "op-id" ||
			failure.kind === "query") &&
		failure.rollback
	) {
		emitStatus(deps.onStatus, {
			kind: "warning",
			code: "abandon_failed",
			message: `jj op abandon ${failure.rollback.op} failed (exit ${failure.rollback.exitCode}): ${failure.rollback.stderr} — the aborted seal's operations remain unintegrated and invisible`,
		});
	}

	switch (failure.kind) {
		case "integrate":
			emitStatus(deps.onStatus, {
				kind: "error",
				code: "integrate_failed",
				message: `jj op integrate failed (exit ${failure.exitCode}): ${failure.stderr} — the seal completed but is not integrated; recover manually with: jj op integrate ${failure.op}`,
			});
			return;
		case "command":
		case "op-id":
			emitStatus(deps.onStatus, {
				kind: "error",
				code: sealStepCode(failure.mutation),
				message: formatFailure(failure),
			});
			return;
		case "query":
		case "decode":
			emitStatus(deps.onStatus, {
				kind: "error",
				code: "head_op_failed",
				message: formatFailure(failure),
			});
			return;
	}
}

/**
 * Best-effort divergence report after a committed seal.
 *
 * The integrate merges the seal with foreign operations other sessions
 * landed meanwhile. When one of those operations rewrote the change we
 * just stamped, the merge leaves divergent variants — two visible commits
 * sharing the change id. Report it; never auto-repair it (ADR 0004). A
 * failed probe is silently skipped: the seal already succeeded, and a
 * reporting failure must not mask it.
 */
async function reportDivergence(
	jj: Jj,
	deps: StampDeps,
	wsPath: string,
): Promise<void> {
	// After the seal's `jj new`, the stamped change sits at `@-`.
	let changeId: string;
	try {
		const stamped = await jj.log("@-", { cwd: wsPath });
		const first = stamped[0];
		if (first === undefined) return;
		changeId = first.changeId;
	} catch {
		return;
	}
	if (changeId.length === 0) return;

	let divergent: { changeId: string }[];
	try {
		divergent = await jj.log("divergent()", { cwd: wsPath });
	} catch {
		return;
	}
	if (!divergent.some((commit) => commit.changeId === changeId)) return;

	emitStatus(deps.onStatus, {
		kind: "warning",
		code: "divergence-after-integrate",
		message: `divergent variants of the stamped change ${changeId} exist — a concurrent operation rewrote it while the seal integrated; inspect with: jj log -r ${changeId} — and abandon the unwanted copy with: jj abandon <rev>`,
	});
}

/**
 * Execute the full jj seal on the workspace working copy as an
 * all-or-nothing transaction:
 *
 * 1. Integrated prep: `workspace update-stale`.
 * 2. A transaction recipe: `describe` → `bookmark set` → `jj new`, each run
 *    as a deferred operation chained on the previous and invisible to other
 *    commands until integrated.
 * 3. One `jj op integrate` applies the whole seal at once.
 *
 * Contract on failure: the repository ends unchanged — the change is not
 * described, the bookmark has not moved, no new change exists (unintegrated
 * operations are invisible). Each failure emits a step-specific error
 * status through the sink (`update_stale_failed`, `describe_failed`,
 * `bookmark_set_failed`, `jj_new_failed`, `integrate_failed`); a dangling
 * chain is abandoned by the transaction runner, and an integrate failure
 * carries the operation id so `jj op integrate <id>` is the manual fix.
 */
export async function sealWorkingCopy(
	deps: StampDeps,
	wsPath: string,
	sessionKey: string,
	body: string,
	subject: string,
): Promise<
	{ ok: true; subject: string; rev: string } | { ok: false; reason: "failed" }
> {
	const jj = deps.jj;

	// 1. Integrated prep: ensure the workspace working copy isn't stale.
	try {
		await jj.workspaceUpdateStale({ cwd: wsPath });
	} catch (err) {
		emitStatus(deps.onStatus, {
			kind: "error",
			code: "update_stale_failed",
			message: `jj workspace update-stale ${queryFailureDetail(err)}`,
		});
		return { ok: false, reason: "failed" };
	}

	// 2. The seal is a recipe: describe, move the bookmark, start a fresh
	//    change — deferred, chained, one integrate.
	const result = await jj.transaction(
		async (tx) => {
			await tx.apply({ kind: "describe", rev: "@", message: body });
			await tx.apply({
				kind: "bookmarkSet",
				name: deps.workspaces.bookmarkName(sessionKey),
				rev: "@",
			});
			await tx.apply({ kind: "new" });
		},
		{ cwd: wsPath },
	);
	if (!result.ok) {
		emitSealFailure(result.error, deps);
		return { ok: false, reason: "failed" };
	}

	// 3. Best-effort divergence report — never fails the committed seal.
	await reportDivergence(jj, deps, wsPath);

	return { ok: true, subject, rev: "@" };
}

/**
 * Describe a specific revision with the commit body (no bookmark set, no jj new).
 * Used for non-"@" rev stamps and the diff path's standalone describe.
 */
export async function describeRevision(
	deps: StampDeps,
	wsPath: string,
	rev: string,
	body: string,
	subject: string,
): Promise<
	{ ok: true; subject: string; rev: string } | { ok: false; reason: "failed" }
> {
	const result = await deps.jj.apply(
		{ kind: "describe", rev, message: body },
		{ cwd: wsPath },
	);
	if (!result.ok) {
		emitStatus(deps.onStatus, {
			kind: "error",
			code: "describe_failed",
			message: formatFailure(result.error),
		});
		return { ok: false, reason: "failed" };
	}

	return { ok: true, subject, rev };
}
