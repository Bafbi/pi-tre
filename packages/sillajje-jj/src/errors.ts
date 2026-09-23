/**
 * `JjError` carries a typed `JjFailure` out of the throwing reads.
 *
 * `apply` and `transaction` never throw for expected failures; they return a
 * `Result`. Reads return parsed data, so a failure has to travel as an
 * exception. Callers that branch on failure catch `JjError` and inspect
 * `.failure`; callers that only report use the message.
 */

import type { JjFailure } from "./types.js";

function describeFailure(failure: JjFailure): string {
	switch (failure.kind) {
		case "command":
			return `jj ${failure.mutation.kind} failed (exit ${failure.exitCode}): ${failure.stderr}`;
		case "op-id":
			return `could not parse the operation id from jj ${failure.mutation.kind} output: ${failure.output}`;
		case "integrate":
			return `jj op integrate ${failure.op} failed (exit ${failure.exitCode}): ${failure.stderr}`;
		case "query":
			return `jj ${failure.argv.join(" ")} failed (exit ${failure.exitCode}): ${failure.stderr}`;
		case "decode":
			return `could not decode ${failure.what}: ${failure.raw}`;
	}
}

export class JjError extends Error {
	readonly failure: JjFailure;

	constructor(failure: JjFailure) {
		super(describeFailure(failure));
		this.name = "JjError";
		this.failure = failure;
	}
}

/** Format a `JjFailure` for a status message (error or warning). */
export function formatFailure(failure: JjFailure): string {
	return describeFailure(failure);
}
