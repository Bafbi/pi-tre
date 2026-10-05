/**
 * Unit tests for `collectDiff` and its helpers — the diff budget that keeps a
 * big or ignored file's name and drops its content.
 *
 * The jj boundary is a minimal fake: the tests pin the decision (whole read vs
 * per-file), the fetch shape (one fileset per file), and the omission reasons.
 */

import type { DiffFile, Jj } from "@pi-tre/sillajje-jj";
import { describe, expect, it, vi } from "vitest";
import {
	collectDiff,
	emitDiffCondensed,
	estimateTokens,
	matchesOmit,
	type StatusEvent,
} from "../src/index.js";

const NO_OMIT: readonly string[] = [];
const SMALL_BUDGET = { maxTokens: 1_000, maxLinesPerFile: 10, omit: NO_OMIT };

interface FakeOptions {
	files?: DiffFile[];
	full?: string;
	content?: (path: string) => string;
}

function makeJj(opts: FakeOptions = {}) {
	const contentFor = (options?: { filesets?: readonly string[] }): string => {
		const path = options?.filesets?.at(-1);
		return path === undefined
			? (opts.full ?? "")
			: (opts.content?.(path) ?? "");
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
	it("fetches the whole diff when nothing is omitted and it fits the gate", async () => {
		const { jj, diff } = makeJj({
			files: [{ path: "a.ts", status: "modified", changes: 5 }],
			full: "FULL DIFF",
		});

		const result = await collectDiff(jj, { rev: "@" }, SMALL_BUDGET, "/ws");

		expect(result).toEqual({ text: "FULL DIFF", omitted: [] });
		expect(diff).toHaveBeenCalledWith("@", { cwd: "/ws" });
		expect(jj.diffFiles).toHaveBeenCalledTimes(1);
	});

	it("treats no changed files as an empty diff", async () => {
		const { jj, diff } = makeJj({ full: "" });

		const result = await collectDiff(jj, { rev: "@" }, SMALL_BUDGET, "/ws");

		expect(result).toEqual({ text: "", omitted: [] });
		expect(diff).toHaveBeenCalledTimes(1);
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
		expect(result.omitted).toEqual([
			{
				path: "pnpm-lock.yaml",
				status: "modified",
				changes: 3,
				reason: "ignored",
			},
		]);
		// The lockfile is never fetched, even though it fits the line gate.
		expect(diff).toHaveBeenCalledTimes(1);
		expect(diff).toHaveBeenCalledWith("@", {
			cwd: "/ws",
			filesets: ["src/a.ts"],
		});
	});

	it("leaves the fast path when the whole diff exceeds the token ceiling", async () => {
		// One changed line, but a minified file: the line gate cannot see the
		// size, so the fetched text has to pass the token ceiling.
		const huge = "x".repeat(4_000);
		const { jj, diffFiles } = makeJj({
			files: [{ path: "bundle.min.js", status: "modified", changes: 1 }],
			full: huge,
			content: () => huge,
		});

		const result = await collectDiff(
			jj,
			{ rev: "@" },
			{ maxTokens: 100, maxLinesPerFile: 10, omit: NO_OMIT },
			"/ws",
		);

		expect(diffFiles).toHaveBeenCalledTimes(1);
		expect(result.text).toBe(
			"Modified bundle.min.js (1 lines changed): diff content omitted (over token budget)",
		);
		expect(result.omitted).toEqual([
			{
				path: "bundle.min.js",
				status: "modified",
				changes: 1,
				reason: "over-budget",
			},
		]);
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
		expect(result.omitted).toEqual([
			{
				path: "big.ts",
				status: "modified",
				changes: 900,
				reason: "too-large",
			},
		]);
		expect(diff).toHaveBeenCalledTimes(1);
		expect(diff).toHaveBeenCalledWith("@", {
			cwd: "/ws",
			filesets: ["small.ts"],
		});
	});

	it("stops inlining once the token budget is spent", async () => {
		const budget = { maxTokens: 1, maxLinesPerFile: 100, omit: NO_OMIT };
		const { jj, diff } = makeJj({
			files: [
				{ path: "a.ts", status: "added", changes: 60 },
				{ path: "b.ts", status: "added", changes: 60 },
			],
			content: () => "abcd",
		});

		const result = await collectDiff(jj, { rev: "@" }, budget, "/ws");

		expect(result.text).toBe(
			[
				"abcd",
				"Added b.ts (60 lines changed): diff content omitted (over token budget)",
			].join("\n"),
		);
		expect(result.omitted.map((file) => file.path)).toEqual(["b.ts"]);
		// b.ts is fetched once, measured, then dropped: the gate needs its size.
		expect(diff).toHaveBeenCalledTimes(2);
	});

	it("fetches a range with the range filesets plus the file path", async () => {
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
			filesets: ["~excluded", "a.ts"],
		});
	});

	it("fetches a small range whole with its filesets", async () => {
		const { jj, diffRange } = makeJj({
			files: [{ path: "a.ts", status: "added", changes: 1 }],
			content: () => "RANGE FULL",
		});

		const result = await collectDiff(
			jj,
			{ from: "base", to: "tip", filesets: ["~excluded"] },
			SMALL_BUDGET,
			"/ws",
		);

		expect(result.text).toBe("RANGE FULL");
		expect(diffRange).toHaveBeenCalledWith("base", "tip", {
			cwd: "/ws",
			filesets: ["~excluded"],
		});
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
				message: "diff condensed: 1 file kept by name only (big.ts)",
			},
		]);
	});

	it("stays silent when nothing was dropped", async () => {
		const { jj } = makeJj({
			files: [{ path: "a.ts", status: "modified", changes: 1 }],
			full: "SMALL",
		});
		const { sink, events } = collectingSink();

		await collectDiff(jj, { rev: "@" }, SMALL_BUDGET, "/ws", sink);

		expect(events).toEqual([]);
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
				message:
					"diff condensed: 2 files kept by name only (a.ts, b.ts)",
			},
		]);
	});
});
