/**
 * Pure argv builders. Every jj command line the package runs is made here, so
 * the process invocations stay in one module and are asserted by unit tests.
 */

import type { Mutation } from "./types.js";

/** Global flag added to every call: a user's color config cannot poison output. */
export const COLOR_FLAG = "--color=never";

/** A JSON object per entry, newline-terminated so `.split("\n")` decodes cleanly. */
const JSON_LINE_TEMPLATE = 'json(self) ++ "\\n"';

/** A commit id per line, used to diff a revset between two operations. */
const COMMIT_ID_LINE_TEMPLATE = 'commit_id ++ "\\n"';

/** `name:root` pairs — the JSON form of a workspace has no root. */
const WORKSPACE_LINE_TEMPLATE = 'name ++ ":" ++ root ++ "\\n"';

/** Conflicted path per line. `resolve --list` shares exit 2 for none and error, so it is never used. */
const CONFLICT_PATH_TEMPLATE = 'if(conflict, path ++ "\\n")';

/** The argv for one Mutation, without the transaction flags `apply` adds. */
export function mutationArgv(mutation: Mutation): string[] {
	switch (mutation.kind) {
		case "describe":
			return ["describe", "-r", mutation.rev, "-m", mutation.message];
		case "new": {
			const argv = ["new", ...(mutation.revs ?? [])];
			if (mutation.edit === false) argv.push("--no-edit");
			else if (mutation.edit === true) argv.push("--edit");
			return argv;
		}
		case "bookmarkSet":
			return ["bookmark", "set", mutation.name, "-r", mutation.rev];
		case "duplicate":
			return [
				"duplicate",
				mutation.revset,
				"--onto",
				mutation.destination,
			];
		case "squash": {
			const argv = [
				"squash",
				"--from",
				mutation.from,
				"--into",
				mutation.onto,
			];
			if (mutation.message !== undefined) {
				argv.push("-m", mutation.message);
			}
			return argv;
		}
		case "rebase": {
			const argv = ["rebase", "-s", mutation.source];
			for (const onto of mutation.onto) argv.push("-o", onto);
			return argv;
		}
	}
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function logArgv(revset: string): string[] {
	return ["log", "-r", revset, "--no-graph", "-T", JSON_LINE_TEMPLATE];
}

export function diffArgv(revset: string): string[] {
	return ["diff", "-r", revset];
}

/**
 * `jj diff --from <from> --to <to>`. Unlike `diff -r <from>..<to>`, this
 * diffs two trees and tolerates a range whose graph has gaps (a merge whose
 * other parent is the range base). jj rejects the `-r` form with "Cannot diff
 * revsets with gaps in."
 */
export function diffRangeArgv(from: string, to: string): string[] {
	return ["diff", "--from", from, "--to", to];
}

export function conflictsArgv(revset?: string): string[] {
	const argv = ["file", "list"];
	if (revset !== undefined) argv.push("-r", revset);
	argv.push("-T", CONFLICT_PATH_TEMPLATE);
	return argv;
}

export function bookmarksArgv(): string[] {
	return ["bookmark", "list", "-T", JSON_LINE_TEMPLATE];
}

export function workspacesArgv(): string[] {
	return ["workspace", "list", "-T", WORKSPACE_LINE_TEMPLATE];
}

/** `jj --version`; the one read that takes no subcommand. */
export function versionArgv(): string[] {
	return ["--version"];
}

/** The head operation id — the base a transaction chain starts from. */
export function headOperationArgv(): string[] {
	return ["op", "log", "-n", "1", "--no-graph", "-T", "id"];
}

/** Commits in `revset`, as they existed at `op`. Used for created-commit discovery. */
export function commitsAtOpArgv(revset: string, op: string): string[] {
	return [
		"log",
		"-r",
		revset,
		"--at-op",
		op,
		"--ignore-working-copy",
		"--no-graph",
		"-T",
		JSON_LINE_TEMPLATE,
	];
}

/** Commit ids in `revset`, as they existed at `op`. Used to resolve a `new` base. */
export function commitIdsAtOpArgv(revset: string, op: string): string[] {
	return [
		"log",
		"-r",
		revset,
		"--at-op",
		op,
		"--ignore-working-copy",
		"--no-graph",
		"-T",
		COMMIT_ID_LINE_TEMPLATE,
	];
}

// ---------------------------------------------------------------------------
// Operation id parsing
// ---------------------------------------------------------------------------

/**
 * Parse the operation id jj prints for a deferred step. jj 0.44 prints, on
 * stderr:
 *
 *   Operation left uncommitted because --no-integrate-operation was requested: 9c6f4b360d4b
 *
 * No machine-readable id exists, so this one line is the uncontrolled string.
 * The runner takes the last match; the format is pinned by a fixture and a test.
 */
export function parsePrintedOpId(output: string): string | undefined {
	const pattern = /--no-integrate-operation was requested: ([0-9a-f]{12,})/g;
	let last: string | undefined;
	for (const match of output.matchAll(pattern)) {
		last = match[1];
	}
	return last;
}

/** jj's no-op notice; a step that prints it minted no operation. */
export const NOTHING_CHANGED = "Nothing changed.";
