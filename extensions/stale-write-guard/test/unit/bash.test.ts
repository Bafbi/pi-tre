import { describe, expect, it } from "vitest";

import { extractFullReadPaths } from "../../src/bash.js";

describe("extractFullReadPaths", () => {
	it("returns the file of a plain cat", () => {
		expect(extractFullReadPaths("cat notes.txt")).toEqual(["notes.txt"]);
	});

	it("returns all files of a multi-file cat", () => {
		expect(extractFullReadPaths("cat a.txt b.txt")).toEqual([
			"a.txt",
			"b.txt",
		]);
	});

	it("ignores cat with flags", () => {
		expect(extractFullReadPaths("cat -n notes.txt")).toEqual([]);
		expect(extractFullReadPaths("cat --number notes.txt")).toEqual([]);
		expect(extractFullReadPaths("cat -s notes.txt")).toEqual([]);
		expect(extractFullReadPaths("cat -A notes.txt")).toEqual([]);
	});

	it("ignores partial readers", () => {
		expect(extractFullReadPaths("head -n 5 notes.txt")).toEqual([]);
		expect(extractFullReadPaths("tail -f log.txt")).toEqual([]);
		expect(extractFullReadPaths("bat --style=plain notes.txt")).toEqual([]);
		expect(extractFullReadPaths("sed -n '1p' notes.txt")).toEqual([]);
		expect(extractFullReadPaths("awk '{print}' notes.txt")).toEqual([]);
		expect(extractFullReadPaths("grep stale notes.txt")).toEqual([]);
		expect(extractFullReadPaths("rg 'todo' src/index.ts")).toEqual([]);
	});

	it("handles quoted paths", () => {
		expect(extractFullReadPaths("cat 'my file.txt'")).toEqual([
			"my file.txt",
		]);
	});

	it("handles escaped spaces in paths", () => {
		expect(extractFullReadPaths("cat my\\ file.txt")).toEqual([
			"my file.txt",
		]);
	});

	it("skips environment assignments before the command", () => {
		expect(extractFullReadPaths("LC_ALL=C cat notes.txt")).toEqual([
			"notes.txt",
		]);
	});

	it("extracts full reads from sequential segments", () => {
		expect(extractFullReadPaths("cat a.txt && cat b.txt")).toEqual([
			"a.txt",
			"b.txt",
		]);
		expect(extractFullReadPaths("cat a.txt; grep x b.txt")).toEqual([
			"a.txt",
		]);
	});

	it("ignores cat after a directory change", () => {
		expect(extractFullReadPaths("cd dir && cat file.txt")).toEqual([]);
		expect(extractFullReadPaths("cd dir; cat file.txt")).toEqual([]);
		expect(
			extractFullReadPaths("cat before.txt && cd dir && cat after.txt"),
		).toEqual(["before.txt"]);
	});

	it("ignores non-reading commands", () => {
		expect(extractFullReadPaths("rm notes.txt")).toEqual([]);
		expect(extractFullReadPaths("echo hello")).toEqual([]);
		expect(extractFullReadPaths("")).toEqual([]);
	});

	it("ignores pipes and redirects", () => {
		expect(extractFullReadPaths("cat notes.txt | wc -l")).toEqual([]);
		expect(extractFullReadPaths("cat notes.txt > copy.txt")).toEqual([]);
		expect(extractFullReadPaths("cat notes.txt 2>err.txt")).toEqual([]);
	});

	it("ignores commands with substitutions or backgrounding", () => {
		expect(extractFullReadPaths("cat $(find . -name x)")).toEqual([]);
		expect(extractFullReadPaths("cat `ls`")).toEqual([]);
		expect(extractFullReadPaths("cat $FILE")).toEqual([]);
		expect(extractFullReadPaths("cat notes.txt &")).toEqual([]);
	});

	it("ignores unterminated quotes", () => {
		expect(extractFullReadPaths("cat 'notes.txt")).toEqual([]);
	});

	it("ignores unknown commands that look like reads", () => {
		expect(extractFullReadPaths("catter notes.txt")).toEqual([]);
	});
});
