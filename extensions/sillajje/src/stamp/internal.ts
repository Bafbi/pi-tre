/**
 * Internal helpers shared across stamp sub-modules.
 */

import type { SillajjeConfig } from "../config.js";
import { sessionBookmark } from "./bookmark.js";
import type { StampConfig, StampDeps, StampStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Config extraction
// ---------------------------------------------------------------------------

/**
 * Extract stamping options from the fully-populated SillajjeConfig.
 * The sync-drift between schema defaults and these extraction defaults
 * is pinned by unit tests against `Default(SillajjeConfigSchema, {})`.
 */
export function getStampConfig(cfg: SillajjeConfig): StampConfig {
	return {
		headerMode: cfg.message?.header ?? "one_line",
		traceEnabled: cfg.message?.body?.trace?.enabled ?? true,
		traceDetail: cfg.message?.body?.trace?.detail ?? "high",
		metaFields: cfg.message?.body?.meta ?? {},
		metaEnabled: cfg.message?.body?.meta?.enabled ?? true,
		showUserPrompt: cfg.message?.body?.user_prompt ?? true,
		showResponse: cfg.message?.body?.response ?? true,
		maxAttempts: cfg.subGenerator?.retry?.maxAttempts ?? 3,
		timeoutMs: cfg.subGenerator?.timeoutMs ?? 30_000,
		model: cfg.subGeneratorModel ?? "openai/gpt-4o-mini",
	};
}

// ---------------------------------------------------------------------------
// Status emission (infallible)
// ---------------------------------------------------------------------------

/**
 * Emit a status through the onStatus sink.
 * A throwing sink is caught — it must never corrupt the stamp.
 */
export function emit(status: StampStatus, deps: StampDeps): void {
	if (!deps.onStatus) return;
	try {
		deps.onStatus(status);
	} catch {
		// A throwing sink must never corrupt the stamp.
	}
}

// ---------------------------------------------------------------------------
// jj seal sequence — a deferred-integration transaction
// ---------------------------------------------------------------------------

/** Flags every transaction step carries. `--at-op` implies
 * `--ignore-working-copy` in jj; both are passed explicitly. */
const DEFERRED_FLAGS = ["--ignore-working-copy", "--no-integrate-operation"];

/**
 * Parse the operation id jj prints for a deferred step.
 *
 * jj 0.44 prints, on stderr:
 *
 * 	Operation left uncommitted because --no-integrate-operation was requested: 9c6f4b360d4b
 *
 * The id is the 12-hex short prefix. The notice is searched in stdout and
 * stderr alike (the stream has moved across jj versions). Pinned by the
 * unit tests — a jj output change must fail a test, not break a seal
 * silently.
 */
function parsePrintedOpId(output: string): string | undefined {
	const m = output.match(
		/--no-integrate-operation was requested: ([0-9a-f]{12,})/,
	);
	return m ? m[1] : undefined;
}

/**
 * Capture the repository's current head operation id — the base the
 * transaction chain starts from. `jj op log -T 'id'` prints the full hex id.
 */
async function headOperationId(
	deps: StampDeps,
	wsPath: string,
): Promise<string | undefined> {
	const result = await deps.exec(
		"jj",
		["op", "log", "-n", "1", "--no-graph", "-T", "id"],
		{ cwd: wsPath },
	);
	const id = result.stdout.trim();
	if (result.code !== 0 || !/^[0-9a-f]+$/.test(id)) return undefined;
	return id;
}

/**
 * Run one deferred transaction step.
 *
 * Returns the operation id the next step chains on plus whether this step
 * minted it, or `undefined` when the step failed (the error status is
 * emitted before returning). The `minted` flag is what lets the caller
 * tell a real dangling operation from the integrated head: a no-op step
 * returns the *previous* id, which must never be abandoned.
 *
 * A step can be a no-op — the session bookmark already pointing at `@`, a
 * re-describe with an identical message — and then jj prints
 * "Nothing changed." and mints no operation. The state is unchanged, so
 * the chain continues from the previous operation id. Unparseable output
 * of a changed step is a loud failure instead: silently continuing would
 * integrate a seal missing that step's effect.
 */
interface DeferredStep {
	/** The id the next step chains on (this step's own, or the previous). */
	opId: string;
	/** Whether this step minted a new unintegrated operation. */
	minted: boolean;
}

async function deferredStep(
	deps: StampDeps,
	wsPath: string,
	params: string[],
	prevOpId: string,
	errorCode: string,
): Promise<DeferredStep | undefined> {
	const result = await deps.exec("jj", params, { cwd: wsPath });
	const combined = `${result.stdout}\n${result.stderr}`;
	if (result.code !== 0) {
		emit(
			{
				kind: "error",
				code: errorCode,
				message: `jj ${params[0]} failed (exit ${result.code}): ${result.stderr}`,
			},
			deps,
		);
		return undefined;
	}
	const opId = parsePrintedOpId(combined);
	if (opId !== undefined) return { opId, minted: true };
	if (combined.includes("Nothing changed.")) {
		// jj minted no operation — the step's end state already holds.
		return { opId: prevOpId, minted: false };
	}
	emit(
		{
			kind: "error",
			code: errorCode,
			message: `could not parse the operation id from jj ${params[0]} output: ${combined.trim()}`,
		},
		deps,
	);
	return undefined;
}

/**
 * Best-effort abandon of a dangling operation chain, starting at its first
 * unintegrated operation. Abandoning the tip would integrate its ancestors
 * (jj reparents on abandon), so the chain is always abandoned head-first.
 * A failed abandon is a non-fatal warning — the dangling ops stay inert.
 */
async function abandonDanglingChain(
	deps: StampDeps,
	wsPath: string,
	firstOpId: string,
): Promise<void> {
	const result = await deps.exec("jj", ["op", "abandon", firstOpId], {
		cwd: wsPath,
	});
	if (result.code !== 0) {
		emit(
			{
				kind: "warning",
				code: "abandon_failed",
				message: `jj op abandon ${firstOpId} failed (exit ${result.code}): ${result.stderr} — the aborted seal's operations remain unintegrated and invisible`,
			},
			deps,
		);
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
	deps: StampDeps,
	wsPath: string,
): Promise<void> {
	// After the seal's `jj new`, the stamped change sits at `@-`.
	const stamped = await deps.exec(
		"jj",
		["log", "-r", "@-", "--no-graph", "-T", "change_id"],
		{ cwd: wsPath },
	);
	if (stamped.code !== 0) return;
	const changeId = stamped.stdout.trim().split("\n")[0] ?? "";
	if (changeId.length === 0 || changeId.includes(" ")) return;

	const divergent = await deps.exec(
		"jj",
		["log", "-r", "divergent()", "--no-graph", "-T", "change_id"],
		{ cwd: wsPath },
	);
	if (divergent.code !== 0) return;
	if (!divergent.stdout.split("\n").includes(changeId)) return;

	emit(
		{
			kind: "warning",
			code: "divergence-after-integrate",
			message: `divergent variants of the stamped change ${changeId} exist — a concurrent operation rewrote it while the seal integrated; inspect with: jj log -r ${changeId} — and abandon the unwanted copy with: jj abandon <rev>`,
		},
		deps,
	);
}

/**
 * Execute the full jj seal on the workspace working copy as an
 * all-or-nothing transaction:
 *
 * 1. Integrated prep: `workspace update-stale`, then capture of the head
 *    operation id.
 * 2. Transaction: `describe` → `bookmark set` → `jj new`, each chained on
 *    the previous step's printed operation id with `--at-op` and deferred
 *    (`--no-integrate-operation`) — invisible to other commands until
 *    integrated.
 * 3. Commit: one `jj op integrate` applies the whole seal at once.
 *
 * Contract on failure: the repository ends unchanged — the change is not
 * described, the bookmark has not moved, no new change exists (unintegrated
 * operations are invisible). Each failure emits a step-specific error
 * status through the sink (`update_stale_failed`, `describe_failed`,
 * `bookmark_set_failed`, `jj_new_failed`, `integrate_failed`); a dangling
 * chain is abandoned best-effort, and an integrate failure carries the
 * operation id so `jj op integrate <id>` is the manual fix.
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
	// 1. Integrated prep: ensure the workspace working copy isn't stale.
	const updateResult = await deps.exec("jj", ["workspace", "update-stale"], {
		cwd: wsPath,
	});
	if (updateResult.code !== 0) {
		emit(
			{
				kind: "error",
				code: "update_stale_failed",
				message: `jj workspace update-stale failed (exit ${updateResult.code}): ${updateResult.stderr}`,
			},
			deps,
		);
		return { ok: false, reason: "failed" };
	}

	// 2. Integrated prep: capture the head operation id the chain starts from.
	const head = await headOperationId(deps, wsPath);
	if (head === undefined) {
		emit(
			{
				kind: "error",
				code: "head_op_failed",
				message:
					"could not capture the head operation id (jj op log failed)",
			},
			deps,
		);
		return { ok: false, reason: "failed" };
	}

	// The first operation the chain actually minted, if any. A no-op step
	// returns the integrated head id, so only a minted id is ever a valid
	// abandon target; abandoning the head would target an integrated
	// operation.
	let firstDanglingOpId: string | undefined;
	const trackDangling = (step: DeferredStep) => {
		if (step.minted && firstDanglingOpId === undefined) {
			firstDanglingOpId = step.opId;
		}
	};
	const abandonIfDangling = async () => {
		if (firstDanglingOpId !== undefined) {
			await abandonDanglingChain(deps, wsPath, firstDanglingOpId);
		}
	};

	// 3. Transaction step: describe the working copy with the commit body.
	const describeStep = await deferredStep(
		deps,
		wsPath,
		["describe", "--at-op", head, ...DEFERRED_FLAGS, "-m", body],
		head,
		"describe_failed",
	);
	if (describeStep === undefined) {
		// The step failed. An unparseable op id leaves a dangling operation
		// this code cannot name; with no known target there is nothing to
		// abandon.
		return { ok: false, reason: "failed" };
	}
	trackDangling(describeStep);

	// 4. Transaction step: point the session bookmark at the stamped copy.
	const bookmarkStep = await deferredStep(
		deps,
		wsPath,
		[
			"bookmark",
			"set",
			sessionBookmark(sessionKey),
			"-r",
			"@",
			"--at-op",
			describeStep.opId,
			...DEFERRED_FLAGS,
		],
		describeStep.opId,
		"bookmark_set_failed",
	);
	if (bookmarkStep === undefined) {
		await abandonIfDangling();
		return { ok: false, reason: "failed" };
	}
	trackDangling(bookmarkStep);

	// 5. Transaction step: seal the working copy and start a fresh one.
	const newStep = await deferredStep(
		deps,
		wsPath,
		["new", "--at-op", bookmarkStep.opId, ...DEFERRED_FLAGS],
		bookmarkStep.opId,
		"jj_new_failed",
	);
	if (newStep === undefined) {
		await abandonIfDangling();
		return { ok: false, reason: "failed" };
	}

	// 6. Commit the transaction: one integrate applies the whole seal.
	const newOp = newStep.opId;
	const integrateResult = await deps.exec("jj", ["op", "integrate", newOp], {
		cwd: wsPath,
	});
	if (integrateResult.code !== 0) {
		// Every step succeeded but the integrate failed. The dangling chain
		// is intentionally preserved — `jj op integrate <id>` is the
		// documented manual recovery.
		emit(
			{
				kind: "error",
				code: "integrate_failed",
				message: `jj op integrate failed (exit ${integrateResult.code}): ${integrateResult.stderr} — the seal completed but is not integrated; recover manually with: jj op integrate ${newOp}`,
			},
			deps,
		);
		return { ok: false, reason: "failed" };
	}

	// 7. Best-effort divergence report — never fails the committed seal.
	await reportDivergence(deps, wsPath);

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
	const descResult = await deps.exec(
		"jj",
		["describe", "-r", rev, "-m", body],
		{ cwd: wsPath },
	);
	if (descResult.code !== 0) {
		emit(
			{
				kind: "error",
				code: "describe_failed",
				message: `jj describe failed (exit ${descResult.code}): ${descResult.stderr}`,
			},
			deps,
		);
		return { ok: false, reason: "failed" };
	}

	return { ok: true, subject, rev };
}
