import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BENCH_DIR, type PinnedRepo, parsePinnedRepo } from "./clones.ts";

/** An alternate citation that answers the fact just as well as the primary. */
export interface AcceptedCitation {
	/** Path relative to the repository root. */
	path: string;
	/** First and last line of the accepted window, 1-based, inclusive. */
	lineRange: [number, number];
	/** The symbol a accepted citation must still show on its line. */
	symbol: string;
	/** Why this citation is valid, for a human reading the report. */
	note: string;
}

/** One claim the answer must contain, with the line it lives on. */
export interface ExpectedFact {
	/** Path relative to the repository root. */
	path: string;
	/** Exact 1-based line where `symbol` occurs. */
	line: number;
	/** The most specific symbol on that line. */
	symbol: string;
	note: string;
	/** Other citations that answer this fact: a usage site, a re-export, a test. */
	accept?: AcceptedCitation[];
}

interface BenchTask {
	id: string;
	title: string;
	/** Pinned repositories, as `"owner/repo@<sha>"`. */
	repos: string[];
	query: string;
	/** True when the correct answer is that the fact does not exist. */
	negative: boolean;
	/**
	 * Terms a negative answer must have searched for. Evidence of search is two
	 * tool calls whose arguments mention one of them.
	 */
	evidenceTerms?: string[];
	expected: ExpectedFact[];
	/** Accepted distance between the cited line and `expected[].line`. */
	lineSlack: number;
}

export interface LoadedTask extends BenchTask {
	pinned: PinnedRepo[];
}

const DEFAULT_LINE_SLACK = 3;

type RawTask = Omit<BenchTask, "lineSlack"> & { lineSlack?: number };

/** Read `bench/tasks.json`, apply the defaults, and resolve the pinned repos. */
export function loadTasks(): LoadedTask[] {
	const path = join(BENCH_DIR, "tasks.json");
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
		tasks: RawTask[];
	};
	return parsed.tasks.map((task) => ({
		...task,
		lineSlack: task.lineSlack ?? DEFAULT_LINE_SLACK,
		pinned: task.repos.map(parsePinnedRepo),
	}));
}

/** Select tasks by id, or all of them for `all`. */
export function selectTasks(
	tasks: LoadedTask[],
	selector: string,
): LoadedTask[] {
	if (selector === "all") return tasks;
	const wanted = selector
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0);
	const missing = wanted.filter(
		(id) => !tasks.some((task) => task.id === id),
	);
	if (missing.length > 0) {
		throw new Error(`Unknown task id(s): ${missing.join(", ")}`);
	}
	return tasks.filter((task) => wanted.includes(task.id));
}
