/**
 * Diff collection under a token budget.
 *
 * Every stamp and fold feeds the sub-generator a file diff. A working copy
 * can change a generated file with a hundred thousand lines, so the full diff
 * is not a safe prompt input: it can exceed the model's context and turn a
 * stamp into three failed retries and a fallback subject.
 *
 * This module keeps a file's name and change count and drops its content when
 * the content does not fit or the path is configured as noise. The policy has
 * three gates:
 *
 * - `omit` drops a matching path's content before it is fetched, whatever its
 *   size. Lockfiles and minified bundles are the common case.
 * - `maxLinesPerFile` drops a single file's content before it is fetched, so a
 *   monster file is never read into memory.
 * - `maxTokens` bounds the estimated tokens of the content that is fetched.
 *
 * A diff with nothing to omit is still fetched whole when it is small: one
 * `jj diff` call beats a per-file walk.
 */

import type { DiffFile, DiffSpec, Jj } from "@pi-tre/sillajje-jj";
import { emitStatus, type StatusEvent } from "./action.js";
import type { DiffBudget } from "./config.js";

// ---------------------------------------------------------------------------
// Token estimate
// ---------------------------------------------------------------------------

/**
 * Estimate a text's token count as one token per four characters. The
 * estimate is deliberately crude: it is hermetic and controllable, and it is
 * used only to bound a prompt, never to bill or to truncate output.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

/**
 * Compiled omit globs, keyed by pattern. The budget is read once per action
 * and the pattern list is a handful of entries, so the cache is small and
 * lives for the process.
 */
const GLOB_CACHE = new Map<string, RegExp>();

/**
 * Does `path` match any of `patterns`? Patterns use `*` (within a path
 * segment), `**` (across segments), and `?`, anchored to the whole path.
 * `**\/` matches zero or more leading segments, so `**\/*.lock` matches both
 * `yarn.lock` and `vendor/yarn.lock`.
 */
export function matchesOmit(
	path: string,
	patterns: readonly string[],
): boolean {
	return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

function globToRegExp(pattern: string): RegExp {
	const cached = GLOB_CACHE.get(pattern);
	if (cached !== undefined) return cached;
	const regex = compileGlob(pattern);
	GLOB_CACHE.set(pattern, regex);
	return regex;
}

function compileGlob(pattern: string): RegExp {
	let source = "^";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern.charAt(i);
		if (ch === "*") {
			if (pattern.charAt(i + 1) === "*") {
				i++;
				if (pattern.charAt(i + 1) === "/") {
					i++;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
		} else if (ch === "?") {
			source += "[^/]";
		} else if (ch === ".") {
			source += "\\.";
		} else if ("\\^$+()[]{}|".includes(ch)) {
			source += `\\${ch}`;
		} else {
			source += ch;
		}
	}
	return new RegExp(`${source}$`);
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** Why a file's content was left out of the collected diff. */
export type OmitReason = "ignored" | "too-large" | "over-budget";

/** A file whose name and change count stayed in the diff, without its content. */
export interface OmittedFile extends DiffFile {
	reason: OmitReason;
}

/** The diff text that reaches the prompt, plus what it left behind. */
export interface CollectedDiff {
	text: string;
	omitted: OmittedFile[];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<DiffFile["status"], string> = {
	added: "Added",
	modified: "Modified",
	removed: "Deleted",
	renamed: "Renamed",
	copied: "Copied",
};

/** The one-line stand-in a dropped file contributes to the diff text. */
function omittedMarker(file: DiffFile, reason: OmitReason): string {
	const why =
		reason === "ignored"
			? "ignored path"
			: reason === "too-large"
				? "too large"
				: "over token budget";
	return `${STATUS_LABELS[file.status]} ${file.path} (${file.changes} lines changed): diff content omitted (${why})`;
}

/**
 * Emit one info status when content was dropped. Silent when nothing was:
 * a condensed diff must not look like a healthy one, and a healthy one must
 * not warn.
 */
export function emitDiffCondensed(
	onStatus: (event: StatusEvent) => void,
	omitted: readonly OmittedFile[],
): void {
	if (omitted.length === 0) return;
	const shown = omitted.slice(0, 5).map((file) => file.path);
	const extra =
		omitted.length > shown.length
			? `, +${omitted.length - shown.length} more`
			: "";
	emitStatus(onStatus, {
		kind: "info",
		code: "diff-condensed",
		message: `diff condensed: ${omitted.length} file${omitted.length === 1 ? "" : "s"} kept by name only (${shown.join(", ")}${extra})`,
	});
}

// ---------------------------------------------------------------------------
// jj reads
// ---------------------------------------------------------------------------

/** The whole diff in one read. */
function fetchText(jj: Jj, spec: DiffSpec, cwd: string): Promise<string> {
	if ("rev" in spec) return jj.diff(spec.rev, { cwd });
	return jj.diffRange(spec.from, spec.to, {
		cwd,
		...(spec.filesets === undefined ? {} : { filesets: spec.filesets }),
	});
}

/** One file's section of the diff, as jj renders it. */
function fetchFileContent(
	jj: Jj,
	spec: DiffSpec,
	path: string,
	cwd: string,
): Promise<string> {
	if ("rev" in spec) return jj.diff(spec.rev, { cwd, filesets: [path] });
	return jj.diffRange(spec.from, spec.to, {
		cwd,
		filesets: [...(spec.filesets ?? []), path],
	});
}

// ---------------------------------------------------------------------------
// collectDiff
// ---------------------------------------------------------------------------

/**
 * Collect a diff under `budget`, emitting one `diff-condensed` status when
 * content was dropped.
 *
 * A path matching `budget.omit` keeps its name and change count and loses its
 * content whatever its size. Otherwise a file over `maxLinesPerFile` loses its
 * content, and content is fetched in file order until the estimated-token
 * budget is spent, after which every remaining file is name-only.
 *
 * The caller keeps its own failure policy: a read that rejects propagates, so
 * a diff-only stamp can report `diff_fetch_failed` while an interaction stamp
 * can degrade to an empty diff.
 */
export async function collectDiff(
	jj: Jj,
	spec: DiffSpec,
	budget: DiffBudget,
	cwd: string,
	onStatus?: (event: StatusEvent) => void,
): Promise<CollectedDiff> {
	const files = await jj.diffFiles(spec, { cwd });

	const ignored = new Set(
		files
			.filter((file) => matchesOmit(file.path, budget.omit))
			.map((file) => file.path),
	);
	const candidateLines = files.reduce(
		(sum, file) => (ignored.has(file.path) ? sum : sum + file.changes),
		0,
	);

	// Fast path: nothing is name-only and the whole diff is small. The line
	// gate is a cheap filter, not the budget's unit: a minified file is one
	// changed line and megabytes of text, so the fetched text still has to
	// pass the token ceiling before it is inlined.
	if (ignored.size === 0 && candidateLines <= budget.maxLinesPerFile) {
		const text = await fetchText(jj, spec, cwd);
		if (estimateTokens(text) <= budget.maxTokens) {
			return { text, omitted: [] };
		}
	}

	const parts: string[] = [];
	const omitted: OmittedFile[] = [];
	let tokens = 0;
	let spent = false;

	for (const file of files) {
		const reason = omitReason(file, budget, spent, ignored.has(file.path));
		if (reason !== undefined) {
			omitted.push({ ...file, reason });
			parts.push(omittedMarker(file, reason));
			if (reason === "over-budget") spent = true;
			continue;
		}

		const content = await fetchFileContent(jj, spec, file.path, cwd);
		const cost = estimateTokens(content);
		if (tokens + cost > budget.maxTokens) {
			omitted.push({ ...file, reason: "over-budget" });
			parts.push(omittedMarker(file, "over-budget"));
			spent = true;
			continue;
		}
		tokens += cost;
		parts.push(content);
	}

	const result = { text: parts.join("\n"), omitted };
	if (onStatus !== undefined) emitDiffCondensed(onStatus, omitted);
	return result;
}

/**
 * The gates that need no content: an ignored path is always dropped, a file
 * over the per-file line gate is too large, and every file after the budget is
 * spent is over budget. Returns `undefined` when the file's content must be
 * fetched and measured.
 */
function omitReason(
	file: DiffFile,
	budget: DiffBudget,
	spent: boolean,
	ignored: boolean,
): OmitReason | undefined {
	if (ignored) return "ignored";
	if (file.changes > budget.maxLinesPerFile) return "too-large";
	if (spent) return "over-budget";
	return undefined;
}
