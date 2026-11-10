import { readFileSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";

import {
	findFindingsBlock,
	stripFindingsBlock,
	truncateSubagentOutput,
} from "../src/answer-text.ts";
import type { ToolCall } from "./harness.ts";
import type { AcceptedCitation, ExpectedFact, LoadedTask } from "./tasks.ts";

/**
 * A small local copy of the findings-block parser in `src/findings.ts`.
 *
 * The real parser imports `node:fs/promises` and `./types.js`, so a node-run
 * benchmark cannot load it. This copy accepts the same block shape and checks
 * paths and lines against the clones, so a score means the same thing here.
 * The block detection and the truncation are shared with production through
 * `src/answer-text.ts`, so the two cannot drift.
 */
export interface ParsedFinding {
	repo: string | null;
	path: string;
	line: number | null;
	claim: string;
	/** The path resolves to a file inside a clone. */
	exists: boolean;
	/** `exists`, and the line is within the file. */
	verified: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function normalizePath(raw: string): string | null {
	const path = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
	if (path.length === 0 || path.startsWith("/")) return null;
	if (path.split("/").includes("..")) return null;
	return path;
}

/** Read the findings block and drop it from the prose. */
export function parseFindingsBlock(answer: string): {
	prose: string;
	findings: ParsedFinding[];
} {
	const block = findFindingsBlock(answer);
	if (block === null) return { prose: answer, findings: [] };

	let payload: unknown;
	try {
		payload = JSON.parse(block.json);
	} catch {
		return { prose: answer, findings: [] };
	}

	const record = asRecord(payload);
	const entries = Array.isArray(payload)
		? payload
		: Array.isArray(record?.findings)
			? (record?.findings as unknown[])
			: null;
	if (entries === null) return { prose: answer, findings: [] };

	const findings: ParsedFinding[] = [];
	for (const entry of entries) {
		const item = asRecord(entry);
		const claim = item?.claim;
		const rawPath = item?.path;
		if (typeof claim !== "string" || typeof rawPath !== "string") continue;
		const path = normalizePath(rawPath);
		if (path === null) continue;
		const line =
			typeof item?.line === "number" &&
			Number.isInteger(item.line) &&
			item.line >= 1
				? item.line
				: null;
		findings.push({
			repo: typeof item?.repo === "string" ? item.repo : null,
			path,
			line,
			claim: claim.trim().slice(0, 300),
			exists: false,
			verified: false,
		});
	}

	const prose =
		findings.length > 0
			? stripFindingsBlock(answer, block.index, block.length)
			: answer;
	return { prose, findings };
}

function lineCountOf(file: string): number | null {
	try {
		if (!statSync(file).isFile()) return null;
		return readFileSync(file, "utf8").split("\n").length;
	} catch {
		return null;
	}
}

/**
 * Check each finding against the clone it names.
 *
 * A finding with no `repo` is checked against every clone, and a named repo
 * matches on display name, directory name, or the part after the last slash.
 */
export function verifyFindings(
	findings: ParsedFinding[],
	clones: Map<string, string>,
): ParsedFinding[] {
	const dirNames = new Map<string, string>();
	for (const [displayName, path] of clones) {
		dirNames.set(basename(path), displayName);
	}

	return findings.map((finding) => {
		const candidates = [...clones.entries()].filter(
			([displayName, path]) => {
				if (finding.repo === null) return true;
				const name = finding.repo.trim();
				if (name.length === 0) return true;
				return (
					displayName === name ||
					basename(path) === name ||
					displayName.endsWith(`/${name}`)
				);
			},
		);

		for (const [, clonePath] of candidates) {
			const absolute = resolve(clonePath, finding.path);
			if (
				absolute !== clonePath &&
				!absolute.startsWith(`${clonePath}${sep}`)
			) {
				continue;
			}
			const lines = lineCountOf(absolute);
			if (lines === null) continue;
			return {
				...finding,
				exists: true,
				verified: finding.line === null || finding.line <= lines,
			};
		}
		return { ...finding, exists: false, verified: false };
	});
}

/** One expected citation the scorer will accept for a fact. */
interface Citation {
	path: string;
	symbol: string;
	/** First and last accepted line, 1-based, inclusive. */
	from: number;
	to: number;
	/** `"primary"`: the canonical triple; `"accept"`: an alternate citation. */
	kind: "primary" | "accept";
}

export interface FactScore {
	path: string;
	line: number;
	symbol: string;
	pathHit: boolean;
	/** The symbol appears in the answer body, outside the query echo. */
	symbolInAnswer: boolean;
	/** A tool call's arguments name the symbol, so the child really looked. */
	symbolInArgs: boolean;
	symbolHit: boolean;
	lineHit: boolean;
	/** The accepted range a finding landed in, or null. */
	matchedCitation: string | null;
	/** The line the answer cited for this fact, when it cited one. */
	citedLine: number | null;
	/** The symbol span in the clone that the primary triple anchors to. */
	primaryRange: [number, number] | null;
	score: number;
}

export interface TaskScore {
	taskId: string;
	negative: boolean;
	/** 0..1 */
	score: number;
	/** Score before the fabrication penalty, 0..1. */
	rawScore: number;
	facts: FactScore[];
	findingsCount: number;
	findingsWithPath: number;
	/** Cited paths that exist in no clone. */
	fabricatedPaths: string[];
	/** Findings that cited a real file. */
	verifiableFindings: number;
	answerWords: number;
	/** Characters of the answer as the parent sees it. */
	answerChars: number;
	/** The sentence the absence check matched, for a human to audit. */
	absenceSentence: string | null;
	/** Tool calls whose arguments mention a term the task must be searched for. */
	evidenceCalls: number;
	/** How the score was reached, in one short phrase. */
	reason: string;
}

const ABSENCE_PATTERNS: RegExp[] = [
	/\bno such\b/i,
	/\bnot found\b/i,
	/\bdoes not exist\b/i,
	/\bdoesn't exist\b/i,
	/\bdo not exist\b/i,
	/\bthere is no\b/i,
	/\bthere are no\b/i,
	/\bno built-in\b/i,
	/\bnot present\b/i,
	/\bcannot find\b/i,
	/\bcould not find\b/i,
	/\bno file\b/i,
	/\bno .{0,30}reporter\b/i,
	/\bnone of\b/i,
];

const HEDGE_PATTERN =
	/\b(may|might|possibly|perhaps|likely|probably|unclear|unsure|not sure|if exists)\b/i;

function sentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+|\n+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length > 0);
}

/** First sentence that states the fact is absent. */
function findAbsenceSentence(text: string): string | null {
	for (const sentence of sentences(text)) {
		if (ABSENCE_PATTERNS.some((pattern) => pattern.test(sentence))) {
			return sentence.slice(0, 400);
		}
	}
	return null;
}

function countWords(text: string): number {
	return text.split(/\s+/).filter((word) => word.length > 0).length;
}

/**
 * Does `text` contain `symbol` as a whole identifier?
 *
 * A substring test would count `reject` inside `rejectOnClear` and `_log`
 * inside `_logFn`, which is how a wrong citation scores as right.
 */
export function containsToken(text: string, symbol: string): boolean {
	if (symbol.length === 0) return false;
	const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(
		`(^|[^A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`,
		"i",
	);
	return pattern.test(text);
}

/** Every string value in a tool call's arguments, joined. */
function argsText(call: ToolCall): string {
	const parts: string[] = [];
	const walk = (value: unknown, depth: number): void => {
		if (depth > 3) return;
		if (typeof value === "string") {
			parts.push(value);
			return;
		}
		if (typeof value === "number" || typeof value === "boolean") {
			parts.push(String(value));
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) walk(item, depth + 1);
			return;
		}
		const record = asRecord(value);
		if (record !== undefined) {
			for (const item of Object.values(record)) walk(item, depth + 1);
		}
	};
	walk(call.args, 0);
	return parts.join("\n");
}

/** Does a tool call's arguments name the symbol? */
function calledWithSymbol(calls: ToolCall[], symbol: string): boolean {
	return calls.some((call) => containsToken(argsText(call), symbol));
}

/**
 * Does the answer cite a repository-relative path?
 *
 * A bare basename is not a citation: any file listing would buy every path
 * point. The path must carry its directory, or a `./` or clone-directory
 * prefix that pins it to the repository root.
 */
export function pathMentioned(
	haystack: string,
	path: string,
	dirNames: string[],
): boolean {
	const prefixes = ["", "./", ...dirNames.map((name) => `${name}/`)];
	for (const prefix of prefixes) {
		const needle = `${prefix}${path}`;
		let from = 0;
		for (;;) {
			const index = haystack.indexOf(needle, from);
			if (index === -1) break;
			from = index + 1;
			const before = index === 0 ? "" : (haystack[index - 1] ?? "");
			const after = haystack[index + needle.length] ?? "";
			const okBefore = before === "" || !/[A-Za-z0-9._@/-]/.test(before);
			const okAfter = after === "" || !/[A-Za-z0-9._/-]/.test(after);
			if (okBefore && okAfter) return true;
		}
	}
	return false;
}

/** Cached clone files, so a task reads each file once. */
class CloneFiles {
	private readonly cache = new Map<
		string,
		{ repo: string; lines: string[] } | null
	>();

	private readonly clones: Map<string, string>;

	constructor(clones: Map<string, string>) {
		this.clones = clones;
	}

	/** Read `path` from the first clone that holds it. */
	read(path: string): { repo: string; lines: string[] } | null {
		if (this.cache.has(path)) return this.cache.get(path) ?? null;
		let found: { repo: string; lines: string[] } | null = null;
		for (const [displayName, clonePath] of this.clones) {
			const absolute = resolve(clonePath, path);
			if (
				absolute !== clonePath &&
				!absolute.startsWith(`${clonePath}${sep}`)
			) {
				continue;
			}
			try {
				if (!statSync(absolute).isFile()) continue;
				found = {
					repo: displayName,
					lines: readFileSync(absolute, "utf8").split("\n"),
				};
				break;
			} catch {
				continue;
			}
		}
		this.cache.set(path, found);
		return found;
	}

	dirNames(): string[] {
		return [...this.clones.values()].map((path) => basename(path));
	}
}

/**
 * The contiguous run of lines that mention `symbol`, anchored near `anchor`.
 *
 * This is the symbol's own span: a declaration that wraps over several lines
 * mentions the symbol on each of them. A citation just outside the span is
 * still accepted, widened by `lineSlack` by the caller.
 */
function symbolSpan(
	lines: string[],
	symbol: string,
	anchor: number,
): [number, number] | null {
	const hits: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const text = lines[i];
		if (text !== undefined && containsToken(text, symbol)) hits.push(i + 1);
	}
	if (hits.length === 0) return null;

	let best = hits[0] ?? 1;
	for (const hit of hits) {
		if (Math.abs(hit - anchor) < Math.abs(best - anchor)) best = hit;
	}
	const set = new Set(hits);
	let start = best;
	let end = best;
	while (set.has(start - 1)) start--;
	while (set.has(end + 1)) end++;
	return [start, end];
}

/** The citations the scorer accepts for one fact, with their line windows. */
function citationsFor(
	fact: ExpectedFact,
	files: CloneFiles,
	lineSlack: number,
): Citation[] {
	const citations: Citation[] = [];
	const primary = files.read(fact.path);
	const span =
		primary === null
			? null
			: symbolSpan(primary.lines, fact.symbol, fact.line);
	if (span !== null) {
		citations.push({
			path: fact.path,
			symbol: fact.symbol,
			from: Math.max(1, span[0] - lineSlack),
			to: span[1] + lineSlack,
			kind: "primary",
		});
	} else {
		// The clone is missing the symbol, or the file. Keep the canonical
		// triple so a citation of its path still scores the path.
		citations.push({
			path: fact.path,
			symbol: fact.symbol,
			from: Math.max(1, fact.line - lineSlack),
			to: fact.line + lineSlack,
			kind: "primary",
		});
	}

	for (const accept of fact.accept ?? []) {
		citations.push(acceptCitation(accept, lineSlack));
	}
	return citations;
}

function acceptCitation(accept: AcceptedCitation, lineSlack: number): Citation {
	return {
		path: accept.path,
		symbol: accept.symbol,
		from: Math.max(1, accept.lineRange[0] - lineSlack),
		to: accept.lineRange[1] + lineSlack,
		kind: "accept",
	};
}

function describeCitation(citation: Citation): string {
	return `${citation.path}:${citation.from}-${citation.to}:${citation.symbol}`;
}

/** The finding line only counts when that line really contains the symbol. */
function lineHoldsSymbol(
	files: CloneFiles,
	finding: ParsedFinding,
	citation: Citation,
): boolean {
	if (finding.line === null) return false;
	if (finding.line < citation.from || finding.line > citation.to) {
		return false;
	}
	const file = files.read(citation.path);
	const text = file?.lines[finding.line - 1];
	return text !== undefined && containsToken(text, citation.symbol);
}

/**
 * Score one answer against one task's expected facts.
 *
 * The weights favour the line number, because that is the claim that costs the
 * child the most work and that a wrong answer fakes most easily. Every claim is
 * checked against the clone: a path that contains the symbol nowhere, a line
 * that does not hold it, and a symbol the child never searched for do not score.
 */
export function scoreAnswer(
	task: LoadedTask,
	answer: string,
	clones: Map<string, string>,
	calls: ToolCall[],
): TaskScore {
	// Score what the parent sees: production cuts the answer at 8000 chars
	// before the findings are read, so a padded answer must not score higher.
	const seen = truncateSubagentOutput(answer);
	const { prose, findings } = parseFindingsBlock(seen);
	const checked = verifyFindings(findings, clones);
	const files = new CloneFiles(clones);
	const dirNames = files.dirNames();

	const fabricatedPaths = [
		...new Set(
			checked
				.filter((finding) => !finding.exists)
				.map((finding) => finding.path),
		),
	];
	const findingsWithPath = checked.filter(
		(finding) => finding.path.length > 0,
	);

	if (task.negative) {
		const absenceSentence = findAbsenceSentence(prose);
		const terms = task.evidenceTerms ?? [];
		const evidenceCalls = calls.filter((call) =>
			terms.some((term) => containsToken(argsText(call), term)),
		).length;

		let score: number;
		let reason: string;
		if (fabricatedPaths.length > 0) {
			score = 0;
			reason = `claims ${fabricatedPaths.length} path(s) that do not exist: ${fabricatedPaths.join(", ")}`;
		} else if (absenceSentence === null) {
			score = 0;
			reason = "does not state the fact is absent";
		} else if (evidenceCalls >= 2) {
			score = 1;
			reason = `states the fact is absent, cites no path that does not exist, and searched (${evidenceCalls} tool calls mention ${terms.join("/")})`;
		} else {
			score = 0.5;
			reason = `states the fact is absent, but only ${evidenceCalls} tool call(s) mention ${terms.join("/")}: the search is not evidenced`;
		}
		if (absenceSentence === null && HEDGE_PATTERN.test(prose)) {
			score = 0.5;
			reason = "hedges instead of stating absence";
		}
		return {
			taskId: task.id,
			negative: true,
			score,
			rawScore: score,
			facts: [],
			findingsCount: checked.length,
			findingsWithPath: findingsWithPath.length,
			fabricatedPaths,
			verifiableFindings: checked.length - fabricatedPaths.length,
			answerWords: countWords(prose),
			answerChars: seen.length,
			absenceSentence,
			evidenceCalls,
			reason,
		};
	}

	const facts: FactScore[] = task.expected.map((fact) => {
		const citations = citationsFor(fact, files, task.lineSlack);
		const primary = citations.find((entry) => entry.kind === "primary");
		const pathHit =
			citations.some((citation) =>
				pathMentioned(seen, citation.path, dirNames),
			) ||
			checked.some(
				(finding) =>
					finding.exists &&
					citations.some(
						(citation) => citation.path === finding.path,
					),
			);

		const symbols = [...new Set(citations.map((entry) => entry.symbol))];
		const symbolInAnswer = symbols.some((symbol) =>
			containsToken(seen, symbol),
		);
		const symbolInArgs = symbols.some((symbol) =>
			calledWithSymbol(calls, symbol),
		);
		const symbolHit = symbolInAnswer && symbolInArgs;

		let matchedCitation: string | null = null;
		let citedLine: number | null = null;
		for (const finding of checked) {
			if (!finding.exists) continue;
			for (const citation of citations) {
				if (finding.path !== citation.path) continue;
				if (!lineHoldsSymbol(files, finding, citation)) continue;
				matchedCitation = describeCitation(citation);
				citedLine = finding.line;
				break;
			}
			if (matchedCitation !== null) break;
		}
		const lineHit = matchedCitation !== null;

		const span =
			primary === undefined
				? null
				: files.read(primary.path) === null
					? null
					: symbolSpan(
							files.read(primary.path)?.lines ?? [],
							primary.symbol,
							fact.line,
						);

		return {
			path: fact.path,
			line: fact.line,
			symbol: fact.symbol,
			pathHit,
			symbolInAnswer,
			symbolInArgs,
			symbolHit,
			lineHit,
			matchedCitation,
			citedLine,
			primaryRange: span,
			score:
				0.25 * Number(pathHit) +
				0.35 * Number(symbolHit) +
				0.4 * Number(lineHit),
		};
	});

	const rawScore =
		facts.length === 0
			? 0
			: facts.reduce((sum, fact) => sum + fact.score, 0) / facts.length;
	// A cited path that does not exist is a fabricated location: it costs 0.25
	// of the task score each, and it cannot take a task below zero.
	const penalty = 0.25 * fabricatedPaths.length;
	const score = Math.max(0, rawScore - penalty);

	return {
		taskId: task.id,
		negative: false,
		score,
		rawScore,
		facts,
		findingsCount: checked.length,
		findingsWithPath: findingsWithPath.length,
		fabricatedPaths,
		verifiableFindings: checked.length - fabricatedPaths.length,
		answerWords: countWords(prose),
		answerChars: seen.length,
		absenceSentence: null,
		evidenceCalls: 0,
		reason: `${facts.filter((fact) => fact.pathHit).length}/${facts.length} paths, ${facts.filter((fact) => fact.symbolHit).length}/${facts.length} symbols, ${facts.filter((fact) => fact.lineHit).length}/${facts.length} lines${
			penalty > 0
				? `, -${penalty.toFixed(2)} for ${fabricatedPaths.length} fabricated path(s)`
				: ""
		}`,
	};
}
