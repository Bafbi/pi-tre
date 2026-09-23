#!/usr/bin/env node
/**
 * Compare the current gate's failures against the recorded baseline.
 *
 * `check-baseline.txt` lists the tasks that fail before the refactor. Run this
 * after `mise run check` to tell a new regression from the prepared findings.
 * Exit code 1 means a task failed that the baseline does not list.
 *
 * Run with `mise run check-baseline` or `node scripts/check-baseline.mjs`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const BASELINE_PATH = join(ROOT, "check-baseline.txt");

function readBaseline() {
	try {
		return new Set(
			readFileSync(BASELINE_PATH, "utf8")
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line && !line.startsWith("#")),
		);
	} catch {
		return new Set();
	}
}

let output = "";
try {
	output = execFileSync("mise", ["run", "--continue-on-error", "check"], {
		cwd: ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
	});
} catch (error) {
	const stdout = error.stdout ?? "";
	const stderr = error.stderr ?? "";
	// A spawn failure (no `mise` on PATH) has no output. Do not read it as a
	// clean run with zero failures.
	if (!stdout && !stderr) throw error;
	output = `${stdout}${stderr}`;
}

const current = new Set();
for (const match of output.matchAll(
	/^\[(\/\/[^\]]+)\] (?:exited with status|ERROR task failed)/gm,
)) {
	current.add(match[1]);
}

const baseline = readBaseline();
const added = [...current]
	.filter((task) => !baseline.has(task))
	.sort((a, b) => a.localeCompare(b));
const fixed = [...baseline]
	.filter((task) => !current.has(task))
	.sort((a, b) => a.localeCompare(b));

console.log(`Baseline failures: ${baseline.size}`);
console.log(`Current failures:  ${current.size}`);

if (fixed.length > 0) {
	console.log("\nNow passing. Remove these from check-baseline.txt:");
	for (const task of fixed) console.log(`  ${task}`);
}

if (added.length > 0) {
	console.error("\nNew failures. These are not in the baseline:");
	for (const task of added) console.error(`  ${task}`);
	process.exit(1);
}

console.log("\nNo new failures.");
