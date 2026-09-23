import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createJj, JjError } from "../src/index.js";
import { fail, ok, recordingExec } from "./helpers.js";

const fixture = (name: string): string =>
	readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");

/**
 * The captured JSON lines. Expected values are read back from the fixture, not
 * hardcoded: change ids are random and commit ids carry a timestamp, so a fresh
 * capture always differs. The fixture pins the template *shape*; these tests
 * pin that the decoder maps it.
 */
function rawJsonLines(name: string): any[] {
	return fixture(name)
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

describe("Jj.log", () => {
	it("decodes the json(self) fixture into the Commit shape", async () => {
		const raw = rawJsonLines("log.jsonl");
		const { exec, calls } = recordingExec(() => ok(fixture("log.jsonl")));
		const jj = createJj(exec);

		const commits = await jj.log("@ | @-");

		expect(commits).toEqual(
			raw.map((entry) => ({
				commitId: entry.commit_id,
				changeId: entry.change_id,
				parents: entry.parents,
				description: entry.description,
			})),
		);
		expect(calls[0]).toEqual({
			command: "jj",
			args: [
				"log",
				"-r",
				"@ | @-",
				"--no-graph",
				"-T",
				'json(self) ++ "\\n"',
				"--color=never",
			],
			options: {},
		});
	});

	it("throws a query failure when jj exits non-zero", async () => {
		const { exec } = recordingExec(() => fail("boom"));
		const jj = createJj(exec);

		const error = await jj.log("@").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(JjError);
		expect((error as JjError).failure).toMatchObject({
			kind: "query",
			exitCode: 1,
			stderr: "boom",
		});
	});

	it("throws a decode failure when the template output is not JSON", async () => {
		const { exec } = recordingExec(() => ok("not json\n"));
		const jj = createJj(exec);

		const error = await jj.log("@").catch((e: unknown) => e);
		expect((error as JjError).failure).toMatchObject({
			kind: "decode",
			what: "commit",
		});
	});
});

describe("Jj.diff", () => {
	it("returns the raw diff", async () => {
		const { exec, calls } = recordingExec(() => ok("--- a\n+++ b\n"));
		const jj = createJj(exec);

		await expect(jj.diff("@")).resolves.toBe("--- a\n+++ b\n");
		expect(calls[0]!.args).toEqual(["diff", "-r", "@", "--color=never"]);
	});
});

describe("Jj.diffRange", () => {
	it("diffs two trees with --from/--to", async () => {
		const { exec, calls } = recordingExec(() => ok("--- a\n+++ b\n"));
		const jj = createJj(exec);

		await expect(jj.diffRange("abc", "def")).resolves.toBe(
			"--- a\n+++ b\n",
		);
		expect(calls[0]!.args).toEqual([
			"diff",
			"--from",
			"abc",
			"--to",
			"def",
			"--color=never",
		]);
	});
});

describe("Jj.conflicts", () => {
	it("returns conflicted paths and exits 0", async () => {
		const { exec, calls } = recordingExec(() => ok("a.txt\nb.txt\n"));
		const jj = createJj(exec);

		await expect(jj.conflicts()).resolves.toEqual(["a.txt", "b.txt"]);
		expect(calls[0]!.args).toEqual([
			"file",
			"list",
			"-T",
			'if(conflict, path ++ "\\n")',
			"--color=never",
		]);
	});

	it("returns an empty list when there are no conflicts", async () => {
		const { exec } = recordingExec(() => ok(""));
		const jj = createJj(exec);

		await expect(jj.conflicts()).resolves.toEqual([]);
	});
});

describe("Jj.bookmarks", () => {
	it("decodes the json(self) fixture into the Bookmark shape", async () => {
		const raw = rawJsonLines("bookmark.jsonl");
		const { exec } = recordingExec(() => ok(fixture("bookmark.jsonl")));
		const jj = createJj(exec);

		await expect(jj.bookmarks()).resolves.toEqual(
			raw.map((entry) => ({ name: entry.name, target: entry.target })),
		);
	});
});

describe("Jj.workspaces", () => {
	it("decodes the name:root fixture into the Workspace shape", async () => {
		const expected = fixture("workspace-list.txt")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => {
				const colon = line.indexOf(":");
				return {
					name: line.slice(0, colon).trim(),
					root: line.slice(colon + 1).trim(),
				};
			});
		const { exec, calls } = recordingExec(() =>
			ok(fixture("workspace-list.txt")),
		);
		const jj = createJj(exec);

		await expect(jj.workspaces()).resolves.toEqual(expected);
		expect(calls[0]!.args).toEqual([
			"workspace",
			"list",
			"-T",
			'name ++ ":" ++ root ++ "\\n"',
			"--color=never",
		]);
	});
});
