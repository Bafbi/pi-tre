import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { ParsedRepo, RepoFinding } from "./types.js";

/** Keep the structured payload small enough to read at a glance. */
export const MAX_FINDINGS = 20;
const MAX_CLAIM_CHARS = 300;
/** Files larger than this are checked for existence, not line numbers. */
const MAX_VERIFY_BYTES = 1_048_576;

const FENCED_JSON = /```json[ \t]*\r?\n([\s\S]*?)```/gi;

interface ParsedAnswer {
	/** The answer with the findings block removed. */
	text: string;
	findings: RepoFinding[];
}

/**
 * Read the findings block from a subagent answer and verify it against the
 * clones.
 *
 * The subagent ends its answer with one fenced `json` block:
 *
 * ```json
 * {"findings":[{"repo":"owner/repo","path":"src/a.ts","line":12,"claim":"..."}]}
 * ```
 *
 * A missing or malformed block leaves the answer untouched and returns no
 * findings, so a model that ignores the format still produces a usable
 * answer. A parsed block is removed from the text; `formatOutput` renders the
 * findings instead.
 */
export async function parseFindings(
	answer: string,
	repos: ParsedRepo[],
	tempspace: string,
): Promise<ParsedAnswer> {
	const block = findFindingsBlock(answer);
	if (block === null) return { text: answer, findings: [] };

	let payload: unknown;
	try {
		payload = JSON.parse(block.json);
	} catch {
		return { text: answer, findings: [] };
	}

	const entries = entriesOf(payload);
	if (entries === null) return { text: answer, findings: [] };

	const findings: RepoFinding[] = [];
	for (const entry of entries.slice(0, MAX_FINDINGS)) {
		const finding = await verifyFinding(entry, repos, tempspace);
		if (finding !== null) findings.push(finding);
	}

	return { text: stripBlock(answer, block.index, block.length), findings };
}

function findFindingsBlock(
	answer: string,
): { json: string; index: number; length: number } | null {
	// Take the last block: a model may show an example before the real one.
	const matches = [...answer.matchAll(FENCED_JSON)];
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		if (match === undefined) continue;
		const json = match[1];
		const index = match.index;
		if (json === undefined || index === undefined) continue;
		if (!json.includes('"findings"') && !json.trimStart().startsWith("[")) {
			continue;
		}
		return { json, index, length: match[0].length };
	}
	return null;
}

function entriesOf(payload: unknown): unknown[] | null {
	if (Array.isArray(payload)) {
		// A bare array is only a findings block when every entry looks like a
		// finding. Otherwise a fenced example such as ["read", "grep"] would
		// be stripped from the answer with nothing rendered in its place.
		return payload.length > 0 && payload.every(isFindingShaped)
			? payload
			: null;
	}
	if (typeof payload !== "object" || payload === null) return null;
	const entries = (payload as { findings?: unknown }).findings;
	return Array.isArray(entries) ? entries : null;
}

function isFindingShaped(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.claim === "string" && typeof record.path === "string";
}

function stripBlock(answer: string, index: number, length: number): string {
	return `${answer.slice(0, index)}${answer.slice(index + length)}`
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

async function verifyFinding(
	entry: unknown,
	repos: ParsedRepo[],
	tempspace: string,
): Promise<RepoFinding | null> {
	if (typeof entry !== "object" || entry === null) return null;
	const record = entry as Record<string, unknown>;

	const rawClaim = record.claim;
	if (typeof rawClaim !== "string" || rawClaim.trim().length === 0) {
		return null;
	}
	const claim = rawClaim.trim().slice(0, MAX_CLAIM_CHARS);

	const rawPath = record.path;
	if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
		return null;
	}
	const path = normalizePath(rawPath);
	if (path === null) return null;

	const line = normalizeLine(record.line);
	const named = matchRepo(record.repo, repos);
	const hasNamedRepo =
		typeof record.repo === "string" && record.repo.trim().length > 0;
	// A named but unknown repository must not be checked against every clone.
	// Otherwise a claim for an unrequested repo is verified under a requested
	// one whenever the path happens to exist there.
	if (hasNamedRepo && named === undefined) {
		return {
			repo: null,
			path,
			line,
			claim,
			verified: false,
		};
	}
	const candidates = named === undefined ? repos : [named];

	for (const repo of candidates) {
		const verified = await verifyPath(repo, tempspace, path, line);
		if (verified !== "missing") {
			return {
				repo: repo.displayName,
				path,
				line,
				claim,
				verified,
			};
		}
	}

	// The path did not resolve in any clone. Keep the claim so the caller can
	// see what the model said, marked unverified.
	return {
		repo: named === undefined ? null : named.displayName,
		path,
		line,
		claim,
		verified: false,
	};
}

/** Normalize to a repository-relative path, or null when it escapes. */
function normalizePath(raw: string): string | null {
	const path = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
	if (path.length === 0 || path.startsWith("/")) return null;
	if (path.split("/").includes("..")) return null;
	return path;
}

function normalizeLine(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		return null;
	}
	return value;
}

function matchRepo(
	value: unknown,
	repos: ParsedRepo[],
): ParsedRepo | undefined {
	if (typeof value === "string") {
		const name = value.trim();
		// A named but unknown repository is not the same as an omitted one.
		// Falling back to the only repo would verify a wrong citation.
		if (name.length === 0) return repos.length === 1 ? repos[0] : undefined;
		return repos.find(
			(repo) =>
				repo.displayName === name ||
				repo.dirName === name ||
				repo.displayName.endsWith(`/${name}`),
		);
	}
	return repos.length === 1 ? repos[0] : undefined;
}

/**
 * Check one path inside one clone.
 *
 * Returns `"missing"` when the path does not resolve to a file, `true` when
 * the line is also in range, and `false` when the file exists but the line
 * does not (or the file is too large to check).
 */
async function verifyPath(
	repo: ParsedRepo,
	tempspace: string,
	path: string,
	line: number | null,
): Promise<boolean | "missing"> {
	const root = resolve(tempspace, repo.dirName);
	const absolute = resolve(root, path);
	if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
		return "missing";
	}

	// The lexical check above does not follow symlinks. Canonicalize both
	// paths so a link inside the clone cannot point outside it.
	let rootReal: string;
	let targetReal: string;
	try {
		rootReal = await realpath(root);
		targetReal = await realpath(absolute);
	} catch {
		return "missing";
	}
	if (
		targetReal !== rootReal &&
		!targetReal.startsWith(`${rootReal}${sep}`)
	) {
		return "missing";
	}

	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(targetReal);
	} catch {
		return "missing";
	}
	if (!info.isFile()) return "missing";
	if (line === null) return true;
	if (info.size > MAX_VERIFY_BYTES) return false;

	try {
		const content = await readFile(targetReal, "utf8");
		const lineCount = content.split("\n").length;
		return line <= lineCount;
	} catch {
		return false;
	}
}
