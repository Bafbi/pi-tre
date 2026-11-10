import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";

import { ensureClone, type PinnedRepo, parsePinnedRepo } from "./clones.ts";
import { loadTasks } from "./tasks.ts";

/**
 * Ground-truth gate for the task set.
 *
 * Every expected fact is checked against the pinned clone: the path exists,
 * the symbol is on the cited line (within `lineSlack`), and the file is source
 * rather than a README. Every accepted alternative is checked the same way, so
 * a citation the scorer would accept is a citation the code really supports.
 *
 * Run this before a baseline. A wrong line here would make every later score
 * meaningless.
 */

interface Check {
	ok: boolean;
	detail: string;
}

/** Paths that hold build output, dependencies, or a lockfile. */
const FORBIDDEN_DIRS = ["dist", "node_modules", "build", "coverage"];
const LOCKFILE =
	/^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?|.*\.lock)$/i;

function isDocPath(path: string): boolean {
	const name = basename(path).toLowerCase();
	return name.startsWith("readme") || name.endsWith(".md");
}

/** Why a path is not source that a finding may cite, or null when it is. */
function pathRejection(path: string): string | null {
	if (isDocPath(path)) return `${path} is documentation, not code`;
	if (LOCKFILE.test(basename(path))) {
		return `${path} is a lockfile, not source`;
	}
	for (const segment of path.split("/")) {
		if (FORBIDDEN_DIRS.includes(segment)) {
			return `${path} is under ${segment}/`;
		}
	}
	return null;
}

function linesOf(file: string): string[] | null {
	try {
		if (!statSync(file).isFile()) return null;
		return readFileSync(file, "utf-8").split("\n");
	} catch {
		return null;
	}
}

/** Fail a path that escapes its clone. */
function insideClone(clone: string, path: string): string | null {
	const absolute = resolve(clone, path);
	if (absolute !== clone && !absolute.startsWith(`${clone}${sep}`)) {
		return null;
	}
	return absolute;
}

/**
 * Find the first clone that holds `path`, and read it.
 *
 * A multi-repo task may name the same relative path in either clone, so every
 * pinned clone is tried in order.
 */
function readFromClones(
	pinned: PinnedRepo[],
	clonePaths: Map<string, string>,
	path: string,
): { repo: string; lines: string[] } | null {
	for (const repo of pinned) {
		const clone = clonePaths.get(repo.parsed.displayName);
		if (clone === undefined) continue;
		const absolute = insideClone(clone, path);
		if (absolute === null || !existsSync(absolute)) continue;
		const lines = linesOf(absolute);
		if (lines === null) continue;
		return { repo: repo.parsed.displayName, lines };
	}
	return null;
}

function checkPrimary(
	pinned: PinnedRepo[],
	clonePaths: Map<string, string>,
	fact: { path: string; line: number; symbol: string },
	lineSlack: number,
): Check {
	const rejected = pathRejection(fact.path);
	if (rejected !== null) return { ok: false, detail: rejected };

	const found = readFromClones(pinned, clonePaths, fact.path);
	if (found === null) {
		return {
			ok: false,
			detail: `${fact.path} exists in none of the pinned clones`,
		};
	}

	// Check the window around the cited line, not the first occurrence: most
	// symbols also appear in an import or a type annotation earlier.
	const from = Math.max(0, fact.line - lineSlack - 1);
	const to = Math.min(found.lines.length, fact.line + lineSlack);
	const index = found.lines
		.slice(from, to)
		.findIndex((text) => text.includes(fact.symbol));
	if (index === -1) {
		const anywhere = found.lines.findIndex((text) =>
			text.includes(fact.symbol),
		);
		return {
			ok: false,
			detail:
				anywhere === -1
					? `${fact.path} never contains "${fact.symbol}"`
					: `${fact.path}:${fact.line} expected "${fact.symbol}" within ${lineSlack} lines, nearest is line ${anywhere + 1}`,
		};
	}
	const offset = from + index + 1 - fact.line;
	return {
		ok: true,
		detail: `${fact.path}:${fact.line}:${fact.symbol} in ${found.repo}${offset === 0 ? "" : ` (off by ${offset})`}`,
	};
}

function checkAccepted(
	pinned: PinnedRepo[],
	clonePaths: Map<string, string>,
	accept: { path: string; lineRange: [number, number]; symbol: string },
): Check {
	const rejected = pathRejection(accept.path);
	if (rejected !== null) return { ok: false, detail: rejected };

	const [start, end] = accept.lineRange;
	if (
		!Number.isInteger(start) ||
		!Number.isInteger(end) ||
		start < 1 ||
		end < start
	) {
		return {
			ok: false,
			detail: `${accept.path}: bad lineRange [${start}, ${end}]`,
		};
	}

	const found = readFromClones(pinned, clonePaths, accept.path);
	if (found === null) {
		return {
			ok: false,
			detail: `accepted path ${accept.path} exists in none of the pinned clones`,
		};
	}
	if (end > found.lines.length) {
		return {
			ok: false,
			detail: `accepted range ${accept.path}:${start}-${end} is past the last line (${found.lines.length})`,
		};
	}

	const hit = found.lines
		.slice(start - 1, end)
		.some((text) => text.includes(accept.symbol));
	if (!hit) {
		return {
			ok: false,
			detail: `accepted range ${accept.path}:${start}-${end} never contains "${accept.symbol}"`,
		};
	}
	return {
		ok: true,
		detail: `${accept.path}:${start}-${end}:${accept.symbol}`,
	};
}

async function main(): Promise<number> {
	const tasks = loadTasks();
	const failures: string[] = [];

	for (const task of tasks) {
		const pinned = task.repos.map(parsePinnedRepo);
		const clonePaths = new Map<string, string>();
		for (const repo of pinned) {
			clonePaths.set(repo.parsed.displayName, await ensureClone(repo));
		}

		if (task.negative) {
			if (task.expected.length > 0) {
				failures.push(
					`${task.id}: negative task must have no expected facts`,
				);
				console.log(
					`[fail] ${task.id}: negative task has expected facts`,
				);
				continue;
			}
			const terms = task.evidenceTerms ?? [];
			if (terms.length === 0) {
				failures.push(
					`${task.id}: negative task needs evidenceTerms, or a lazy "not found" wins the cell`,
				);
				console.log(
					`[fail] ${task.id}: negative task needs evidenceTerms`,
				);
				continue;
			}
			console.log(
				`[ok]   ${task.id}: negative task over ${task.repos.join(", ")} (answer must be "not found"; search terms: ${terms.join(", ")}, searched at least 2 tool calls)`,
			);
			continue;
		}

		const primary = task.expected.map((fact) =>
			checkPrimary(pinned, clonePaths, fact, task.lineSlack),
		);
		const accepted = task.expected.flatMap((fact) =>
			(fact.accept ?? []).map((entry) =>
				checkAccepted(pinned, clonePaths, entry),
			),
		);
		const failed = [...primary, ...accepted].filter((check) => !check.ok);
		if (failed.length > 0) {
			for (const check of failed) {
				failures.push(`${task.id}: ${check.detail}`);
			}
			console.log(
				`[fail] ${task.id}: ${failed.map((check) => check.detail).join("; ")}`,
			);
			continue;
		}
		console.log(
			`[ok]   ${task.id}: ${primary.map((check) => check.detail.split(" in ")[0]).join("; ")}${
				accepted.length === 0
					? ""
					: ` (+ ${accepted.length} accepted alternative(s))`
			}`,
		);
	}

	console.log("");
	if (failures.length > 0) {
		console.error(`${failures.length} ground-truth mismatch(es).`);
		return 1;
	}
	console.log(
		`All ${tasks.length} tasks verified against their pinned clones.`,
	);
	return 0;
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	},
);
