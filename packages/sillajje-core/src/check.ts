/**
 * The check gate — one run of the checks one Trigger selects.
 *
 * The core executes the gate; the adapter owns the loop, the report, the
 * waiver tool, and the handoff to the stamp. The split is deliberate: the
 * same one-run primitive serves the settle gate, the publish gate inside a
 * Fold, and `/sillajje:check`, and none of those is allowed to teach the core
 * about pi.
 *
 * A run selects checks by Trigger in declared order, applies each check's
 * path filter against the interaction's diff, runs every selected command,
 * and reports every result. It never stops at the first failure: the retry
 * budget is one report, and a partial report costs a whole extra turn.
 */

import { type CommandPort, emitStatus, type StatusEvent } from "./action.js";
import type { CheckDefinition, CheckTrigger } from "./config.js";
import { matchesGlob } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A check's verdict in one gate run. */
export type CheckStatus =
	| "passed"
	| "failed"
	| "timed-out"
	| "waived"
	| "skipped";

/** What one check did, for the report, the `Checks:` line, and the Record. */
export interface CheckResult {
	name: string;
	status: CheckStatus;
	/** The process exit code, when the command ran. */
	exitCode?: number | undefined;
	/** Wall time the host measured, or 0 when the check did not run. */
	durationMs: number;
	/** Why the check was waived or could not run. */
	reason?: string | undefined;
	/** The command's standard output, for the report. */
	stdout?: string | undefined;
	/** The command's standard error, for the report. */
	stderr?: string | undefined;
}

/** Which gate a run executes, or `all` for an on-demand run. */
export type GateSelector = CheckTrigger | "all";

/** One gate run's input. */
export interface GateInput {
	/** Every declared check; the run selects by Trigger. */
	checks: readonly CheckDefinition[];
	/** The gate to run, or `all` to run every check once. */
	trigger: GateSelector;
	/** The directory every command runs in: the session workspace root. */
	cwd: string;
	/**
	 * The interaction's changed paths, for each check's path filter. `undefined`
	 * means the caller has no diff to filter against, so every check runs.
	 */
	changedPaths?: readonly string[] | undefined;
	/** The turn's abort signal. An abort waives the unfinished checks. */
	signal?: AbortSignal | undefined;
}

/** One gate run's result. */
export interface GateResult {
	trigger: GateSelector;
	results: readonly CheckResult[];
}

/** The terminal verdict a stamp renders: what ran, and whether it moved the tree. */
export interface GateVerdict {
	results: readonly CheckResult[];
	moved?: boolean | undefined;
}

/** The ports a gate run binds. */
export interface GatePorts {
	command: CommandPort;
	onStatus: (event: StatusEvent) => void;
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** Whether any check failed or timed out. A waived check is not red. */
export function gateIsRed(result: GateResult): boolean {
	return result.results.some(
		(check) => check.status === "failed" || check.status === "timed-out",
	);
}

/** Whether the gate selected nothing, or selected only path-skipped checks. */
export function gateRanNothing(result: GateResult): boolean {
	return result.results.every((check) => check.status === "skipped");
}

/** The checks that failed or timed out, in report order. */
export function failingChecks(result: GateResult): readonly CheckResult[] {
	return result.results.filter(
		(check) => check.status === "failed" || check.status === "timed-out",
	);
}

/** One line naming every failing check with its exit code or timeout. */
export function describeFailingChecks(result: GateResult): string {
	return failingChecks(result)
		.map((check) => {
			if (check.status === "timed-out") {
				return `${check.name} (timed-out)`;
			}
			return check.exitCode === undefined
				? `${check.name} (failed)`
				: `${check.name} (exit ${check.exitCode})`;
		})
		.join(", ");
}

/** Whether `trigger` selects `check`. `all` selects every check once. */
export function checkSelected(
	check: CheckDefinition,
	trigger: GateSelector,
): boolean {
	return trigger === "all" || check.triggers.includes(trigger);
}

/**
 * Whether a check's path filter lets it run. A check with no filter always
 * runs; a caller with no diff to filter against runs every check rather than
 * pretending the filter matched.
 */
export function checkPathSelected(
	check: CheckDefinition,
	changedPaths: readonly string[] | undefined,
): boolean {
	if (check.paths.length === 0) return true;
	if (changedPaths === undefined) return true;
	return changedPaths.some((path) => matchesGlob(path, check.paths));
}

// ---------------------------------------------------------------------------
// runGate
// ---------------------------------------------------------------------------

/**
 * Run one gate: every check the trigger selects, in declared order.
 *
 * A check that exceeds its timeout is `timed-out` and red. A check killed by
 * the abort signal is `waived (cancelled)`, and the checks that never started
 * are waived the same way, because the user stopped the run rather than
 * failing it. A check whose path filter matches nothing is `skipped` and
 * costs no process.
 */
export async function runGate(
	ports: GatePorts,
	input: GateInput,
): Promise<GateResult> {
	const selected = input.checks.filter((check) =>
		checkSelected(check, input.trigger),
	);

	const results: CheckResult[] = [];
	// A function, not an inline comparison: the signal may abort during an
	// awaited run, and TypeScript narrows an inline check to always false.
	const isAborted = (): boolean => input.signal?.aborted === true;

	for (const check of selected) {
		emitStatus(ports.onStatus, {
			kind: "phase",
			code: "checking",
			target: check.name,
		});

		if (isAborted()) {
			results.push({
				name: check.name,
				status: "waived",
				durationMs: 0,
				reason: "cancelled",
			});
			continue;
		}

		if (!checkPathSelected(check, input.changedPaths)) {
			results.push({
				name: check.name,
				status: "skipped",
				durationMs: 0,
			});
			continue;
		}

		try {
			const run = await ports.command.exec({
				command: check.command,
				cwd: input.cwd,
				timeoutMs: check.timeoutMs,
				signal: input.signal,
			});

			if (isAborted()) {
				results.push({
					name: check.name,
					status: "waived",
					durationMs: run.durationMs,
					reason: "cancelled",
					stdout: run.stdout,
					stderr: run.stderr,
				});
			} else if (run.killed) {
				results.push({
					name: check.name,
					status: "timed-out",
					durationMs: run.durationMs,
					stdout: run.stdout,
					stderr: run.stderr,
				});
			} else {
				results.push({
					name: check.name,
					status: run.code === 0 ? "passed" : "failed",
					exitCode: run.code,
					durationMs: run.durationMs,
					stdout: run.stdout,
					stderr: run.stderr,
				});
			}
		} catch (err) {
			results.push({
				name: check.name,
				status: "failed",
				durationMs: 0,
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return { trigger: input.trigger, results };
}
