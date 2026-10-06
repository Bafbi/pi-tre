/**
 * Unit tests for `collectDiff` and its helpers — the diff budget that keeps a
 * big or ignored file's name and drops its content.
 *
 * The jj boundary is a minimal fake: the tests pin the fetch shape (one exact
 * fileset per file, no whole-diff read) and the omission markers in the text.
 */

import type { DiffFile, Jj } from "@pi-tre/sillajje-jj";
import { describe, expect, it, vi } from "vitest";
import {
	collectDiff,
	emitDiffCondensed,
	estimateTokens,
	matchesOmit,
} from "../src/diff.js";
import type { StatusEvent } from "../src/index.js";

const NO_OMIT: readonly string[] = [];
const SMALL_BUDGET = { maxTokens: 1_000, maxLinesPerFile: 10, omit: NO_OMIT };

interface FakeOptions {
	files?: DiffFile[];
	content?: (path: string) => string;
}

function makeJj(opts: FakeOptions = {}) {
	const contentFor = (options?: { filesets?: readonly string[] }): string => {
		const fileset = options?.filesets?.at(-1);
		if (fileset === undefined) return "";
		// `fetchFileContent` wraps the path in an exact-match fileset.
		const match = /^file:"(.*)"$/.exec(fileset);
		const path = match
			? (match[1] ?? "").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
			: fileset;
		return opts.content?.(path) ?? "";
	};
	const diff = vi.fn(
		async (_rev: string, options?: { filesets?: readonly string[] }) =>
			contentFor(options),
	);
	const diffRange = vi.fn(
		async (
			_from: string,
			_to: string,
			options?: { filesets?: readonly string[] },
		) => contentFor(options),
	);
	const diffFiles = vi.fn(async () => opts.files ?? []);
	const jj = { diff, diffRange, diffFiles } as unknown as Jj;
	return { jj, diff, diffRange, diffFiles };
}

function collectingSink(): {
	sink: (event: StatusEvent) => void;
	events: StatusEvent[];
} {
	const events: StatusEvent[] = [];
	return { sink: (event) => events.push(event), events };
}

describe("estimateTokens", () => {
	it("is one token per four characters, rounded up", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
	});
});

describe("matchesOmit", () => {
	it("matches a basename at any depth", () => {
		expect(matchesOmit("yarn.lock", ["**/*.lock"])).toBe(true);
		expect(matchesOmit("a/b/uv.lock", ["**/*.lock"])).toBe(true);
		expect(matchesOmit("yarn.lock.bak", ["**/*.lock"])).toBe(false);
		expect(matchesOmit("yarnlock", ["**/*.lock"])).toBe(false);
	});

	it("matches an exact basename", () => {
		expect(matchesOmit("go.sum", ["**/go.sum"])).toBe(true);
		expect(matchesOmit("x/go.sum", ["**/go.sum"])).toBe(true);
		expect(matchesOmit("go.sums", ["**/go.sum"])).toBe(false);
	});

	it("matches a directory subtree", () => {
		expect(matchesOmit("vendor/a/b.ts", ["**/vendor/**"])).toBe(true);
		expect(matchesOmit("x/vendor/a.ts", ["**/vendor/**"])).toBe(true);
		expect(matchesOmit("vendor", ["**/vendor/**"])).toBe(false);
	});

	it("anchors the whole path", () => {
		expect(matchesOmit("a.generated.ts", ["**/*.generated.*"])).toBe(true);
		expect(matchesOmit("a.generated", ["**/*.generated.*"])).toBe(false);
		expect(matchesOmit("pnpm-lock.yaml", ["**/*-lock.yaml"])).toBe(true);
	});
});

describe("collectDiff", () => {
	it("fetches each changed file by its exact path", async () => {
		const { jj, diff } = makeJj({
			files: [
				{ path: "a.ts", status: "modified", changes: 5 },
				{ path: "b.ts", status: "modified", changes: 3 },
			],
			content: (path) => (path === "a.ts" ? "A" : "B"),
		});

		const result = await collectDiff(jj, { rev: "@" }, SMALL_BUDGET, "/ws");

		expect(result.text).toBe("A\nB");
		expect(diff).toHaveBeenNthCalledWith(1, "@", {
			cwd: "/ws",
			filesets: ['file:"a.ts"'],
		});
		expect(diff).toHaveBeenNthCalledWith(2, "@", {
			cwd: "/ws",
			filesets: ['file:"b.ts"'],
		});
		expect(jj.diffFiles).toHaveBeenCalledTimes(1);
	});

	it("treats no changed files as an empty diff, with no file read", async () => {
		const { jj, diff } = makeJj();

		const result = await collectDiff(jj, { rev: "@" }, SMALL_BUDGET, "/ws");

		expect(result.text).toBe("");
		expect(diff).not.toHaveBeenCalled();
	});

	it("drops an ignored path's content whatever its size", async () => {
		const { jj, diff } = makeJj({
			files: [
				{ path: "src/a.ts", status: "modified", changes: 5 },
				{ path: "pnpm-lock.yaml", status: "modified", changes: 3 },
			],
			content: (path) => (path === "src/a.ts" ? "A" : "LOCK"),
		});

		const result = await collectDiff(
			jj,
			{ rev: "@" },
			{ maxTokens: 1_000, maxLinesPerFile: 10, omit: ["**/*-lock.yaml"] },
			"/ws",
		);

		expect(result.text).toBe(
			[
				"A",
				"Modified pnpm-lock.yaml (3 lines changed): diff content omitted (ignored path)",
			].join("\n"),
		);
		// The lockfile is never fetched, even though it fits the line gate.
		expect(diff).toHaveBeenCalledTimes(1);
		expect(diff).toHaveBeenCalledWith("@", {
			cwd: "/ws",
			filesets: ['file:"src/a.ts"'],
		});
	});

	it("drops content that exceeds the token ceiling", async () => {
		// One changed line, but a minified file: the line gate cannot see the
		// size, so the fetched text has to pass the token ceiling.
		const huge = "x".repeat(4_000);
		const { jj } = makeJj({
			files: [{ path: "bundle.min.js", status: "modified", changes: 1 }],
			content: () => huge,
		});

		const result = await collectDiff(
			jj,
			{ rev: "@" },
			{ maxTokens: 100, maxLinesPerFile: 10, omit: NO_OMIT },
			"/ws",
		);

		expect(result.text).toBe(
			"Modified bundle.min.js (1 lines changed): diff content omitted (over token budget)",
		);
	});

	it("keeps a file over the line gate by name only, without fetching it", async () => {
		const { jj, diff } = makeJj({
			files: [
				{ path: "small.ts", status: "modified", changes: 5 },
				{ path: "big.ts", status: "modified", changes: 900 },
			],
			content: (path) => (path === "small.ts" ? "SMALL" : "BIG"),
		});

		const result = await collectDiff(jj, { rev: "@" }, SMALL_BUDGET, "/ws");

		expect(result.text).toBe(
			[
				"SMALL",
				"Modified big.ts (900 lines changed): diff content omitted (too large)",
			].join("\n"),
		);
		expect(diff).toHaveBeenCalledTimes(1);
		expect(diff).toHaveBeenCalledWith("@", {
			cwd: "/ws",
			filesets: ['file:"small.ts"'],
		});
	});

	it("stops inlining once the token budget is spent", async () => {
		const budget = { maxTokens: 150, maxLinesPerFile: 100, omit: NO_OMIT };
		const content = "x".repeat(400); // 100 estimated tokens
		const { jj, diff } = makeJj({
			files: [
				{ path: "a.ts", status: "added", changes: 60 },
				{ path: "b.ts", status: "added", changes: 60 },
			],
			content: () => content,
		});

		const result = await collectDiff(jj, { rev: "@" }, budget, "/ws");

		expect(result.text).toBe(
			[
				content,
				"Added b.ts (60 lines changed): diff content omitted (over token budget)",
			].join("\n"),
		);
		// b.ts is fetched once, measured, then dropped: the gate needs its size.
		expect(diff).toHaveBeenCalledTimes(2);
	});

	it("fetches a range's file by exact path, not the range fileset", async () => {
		const { jj, diffRange } = makeJj({
			files: [
				{ path: "a.ts", status: "added", changes: 1 },
				{ path: "big.ts", status: "added", changes: 900 },
			],
			content: () => "RANGE FILE",
		});

		const result = await collectDiff(
			jj,
			{ from: "base", to: "tip", filesets: ["~excluded"] },
			SMALL_BUDGET,
			"/ws",
		);

		expect(result.text).toBe(
			[
				"RANGE FILE",
				"Added big.ts (900 lines changed): diff content omitted (too large)",
			].join("\n"),
		);
		expect(diffRange).toHaveBeenCalledWith("base", "tip", {
			cwd: "/ws",
			filesets: ['file:"a.ts"'],
		});
	});

	it("escapes a path into an exact-match fileset", async () => {
		const { jj, diff } = makeJj({
			files: [
				{ path: 'weird "name".ts', status: "modified", changes: 5 },
				{ path: "big.ts", status: "modified", changes: 900 },
			],
			content: () => "WEIRD",
		});

		await collectDiff(jj, { rev: "@" }, SMALL_BUDGET, "/ws");

		expect(diff).toHaveBeenCalledWith("@", {
			cwd: "/ws",
			filesets: ['file:"weird \\"name\\".ts"'],
		});
	});

	it("fetches a renamed file by its target path", async () => {
		const { jj, diff } = makeJj({
			files: [
				{ path: "new.ts", status: "renamed", changes: 0 },
				{ path: "big.ts", status: "modified", changes: 900 },
			],
			content: () => "RENAMED",
		});

		const result = await collectDiff(jj, { rev: "@" }, SMALL_BUDGET, "/ws");

		expect(result.text).toContain("RENAMED");
		expect(diff).toHaveBeenCalledWith("@", {
			cwd: "/ws",
			filesets: ['file:"new.ts"'],
		});
	});

	it("collapses markers that no longer fit the token budget", async () => {
		const budget = {
			maxTokens: 40,
			maxLinesPerFile: 10,
			omit: ["**/*.lock"],
		};
		const { jj } = makeJj({
			files: [
				{ path: "a.lock", status: "modified", changes: 1 },
				{ path: "b.lock", status: "modified", changes: 1 },
				{ path: "c.lock", status: "modified", changes: 1 },
			],
		});
		const { sink, events } = collectingSink();

		const result = await collectDiff(jj, { rev: "@" }, budget, "/ws", sink);

		expect(result.text).toContain("Modified a.lock");
		expect(result.text).toContain("... and 2 more files omitted");
		expect(result.text).not.toContain("b.lock");
		// The trailing line is charged too, so the text stays under the ceiling.
		expect(estimateTokens(result.text)).toBeLessThanOrEqual(
			budget.maxTokens,
		);
		expect(events).toEqual([
			{
				kind: "info",
				code: "diff-condensed",
				message:
					"diff condensed: 3 files omitted (a.lock, b.lock, c.lock)",
			},
		]);
	});

	it("omits the collapse line when the budget cannot hold it", async () => {
		const budget = { maxTokens: 0, maxLinesPerFile: 10, omit: NO_OMIT };
		const { jj } = makeJj({
			files: [{ path: "big.ts", status: "modified", changes: 900 }],
		});

		const result = await collectDiff(jj, { rev: "@" }, budget, "/ws");

		expect(result.text).toBe("");
		expect(estimateTokens(result.text)).toBeLessThanOrEqual(
			budget.maxTokens,
		);
	});

	it("emits one diff-condensed status when content was dropped", async () => {
		const { jj } = makeJj({
			files: [{ path: "big.ts", status: "added", changes: 900 }],
		});
		const { sink, events } = collectingSink();

		await collectDiff(jj, { rev: "@" }, SMALL_BUDGET, "/ws", sink);

		expect(events).toEqual([
			{
				kind: "info",
				code: "diff-condensed",
				message: "diff condensed: 1 file omitted (big.ts)",
			},
		]);
	});

	it("stays silent when nothing was dropped", async () => {
		const { jj } = makeJj({
			files: [{ path: "a.ts", status: "modified", changes: 1 }],
			content: () => "SMALL",
		});
		const { sink, events } = collectingSink();

		await collectDiff(jj, { rev: "@" }, SMALL_BUDGET, "/ws", sink);

		expect(events).toEqual([]);
	});

	it("returns the omitted manifest beside the text", async () => {
		const { jj } = makeJj({
			files: [
				{ path: "a.ts", status: "modified", changes: 5 },
				{ path: "pnpm-lock.yaml", status: "modified", changes: 3 },
				{ path: "big.ts", status: "modified", changes: 900 },
			],
			content: (path) => (path === "a.ts" ? "A" : "OTHER"),
		});

		const result = await collectDiff(
			jj,
			{ rev: "@" },
			{ maxTokens: 1_000, maxLinesPerFile: 10, omit: ["**/*-lock.yaml"] },
			"/ws",
		);

		expect(result.text).toContain("A");
		expect(result.omitted).toEqual([
			{
				path: "pnpm-lock.yaml",
				status: "modified",
				changes: 3,
				reason: "ignored",
			},
			{
				path: "big.ts",
				status: "modified",
				changes: 900,
				reason: "too-large",
			},
		]);
	});

	it("returns a token-budget-only drop in the manifest", async () => {
		const { jj } = makeJj({
			files: [
				{ path: "a.ts", status: "added", changes: 60 },
				{ path: "b.ts", status: "added", changes: 60 },
			],
			content: () => "x".repeat(400),
		});

		const result = await collectDiff(
			jj,
			{ rev: "@" },
			{ maxTokens: 150, maxLinesPerFile: 100, omit: [] },
			"/ws",
		);

		// b.ts fits the line gate and the omit list; only the token ceiling
		// dropped it.
		expect(result.omitted).toEqual([
			{
				path: "b.ts",
				status: "added",
				changes: 60,
				reason: "over-budget",
			},
		]);
	});

	it("propagates a rejected read", async () => {
		const { jj } = makeJj();
		(jj.diffFiles as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("jj exploded"),
		);

		await expect(
			collectDiff(jj, { rev: "@" }, SMALL_BUDGET, "/ws"),
		).rejects.toThrow("jj exploded");
	});
});

describe("emitDiffCondensed", () => {
	it("reports the omitted count and the paths", () => {
		const events: StatusEvent[] = [];
		emitDiffCondensed(
			(event) => events.push(event),
			[
				{
					path: "a.ts",
					status: "modified",
					changes: 1,
					reason: "over-budget",
				},
				{
					path: "b.ts",
					status: "added",
					changes: 2,
					reason: "too-large",
				},
			],
		);

		expect(events).toEqual([
			{
				kind: "info",
				code: "diff-condensed",
				message: "diff condensed: 2 files omitted (a.ts, b.ts)",
			},
		]);
	});
});
