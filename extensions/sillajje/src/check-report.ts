/**
 * The Check report: what a red gate hands the agent.
 *
 * The report is the failing checks' raw output, truncated exactly the way a
 * bash tool call truncates it — the last 2000 lines or 50KB, whichever hits
 * first — with a pointer to the complete log. The full output lives outside
 * the workspace, so it never enters a stamp's diff.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CheckResult } from "@pi-tre/sillajje-core";

/** The bash tool's line cap. */
const REPORT_MAX_LINES = 2000;

/** The bash tool's byte cap. */
const REPORT_MAX_BYTES = 50 * 1024;

/** A command's combined output: stdout, then stderr. */
function checkOutput(check: CheckResult): string {
	return [check.stdout ?? "", check.stderr ?? ""]
		.filter((part) => part.length > 0)
		.join("\n");
}

/**
 * Keep the tail of `text` under both limits. A line cap alone is not enough:
 * one minified line can be megabytes, so the byte cap wins when it hits
 * first.
 */
function truncateTail(
	text: string,
	maxLines = REPORT_MAX_LINES,
	maxBytes = REPORT_MAX_BYTES,
): { text: string; truncated: boolean } {
	const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
	const lines = trimmed.split("\n");
	let tail = lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
	let truncated = lines.length > maxLines;

	if (Buffer.byteLength(tail, "utf-8") > maxBytes) {
		const bytes = Buffer.from(tail, "utf-8");
		const cut = bytes.subarray(bytes.length - maxBytes).toString("utf-8");
		// Drop a leading partial line; a truncated multi-byte character is
		// replaced by the decoder and never breaks the report.
		const newline = cut.indexOf("\n");
		tail = newline === -1 ? cut : cut.slice(newline + 1);
		truncated = true;
	}

	return { text: tail, truncated };
}

/**
 * A filesystem-safe filename for a check name. When sanitizing changes the
 * name, a short hash of the original keeps two names that collapse to the
 * same safe string (`a/b` and `a?b`) on separate logs.
 */
function logName(name: string): string {
	const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_");
	if (safe === name) return name;
	const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
	return `${safe}-${hash}`;
}

/** What a red gate writes and renders: the report and its log paths. */
export interface CheckReport {
	/** The transcript message: failing output plus the log pointers. */
	message: string;
	/** The complete-output path per failing check name. */
	logs: ReadonlyMap<string, string>;
}

/**
 * Write one complete log per failing check under `logDir`, then render the
 * truncated report. A green gate writes nothing and renders nothing.
 */
export function buildCheckReport(
	failing: readonly CheckResult[],
	logDir: string,
): CheckReport {
	const logs = new Map<string, string>();
	if (failing.length === 0) return { message: "", logs };

	mkdirSync(logDir, { recursive: true });

	const blocks: string[] = [];
	for (const check of failing) {
		const path = join(logDir, `${logName(check.name)}.log`);
		writeFileSync(path, checkOutput(check), "utf-8");
		logs.set(check.name, path);

		const verdict =
			check.status === "timed-out"
				? "timed-out"
				: check.exitCode === undefined
					? "failed"
					: `failed (exit ${check.exitCode})`;
		const tail = truncateTail(checkOutput(check));
		const pointer = tail.truncated
			? `\n\n[output truncated; full log: ${path}]`
			: `\n\nFull output: ${path}`;
		blocks.push(
			`Check "${check.name}" ${verdict}:\n\n${tail.text}${pointer}`,
		);
	}

	return { message: blocks.join("\n\n"), logs };
}
