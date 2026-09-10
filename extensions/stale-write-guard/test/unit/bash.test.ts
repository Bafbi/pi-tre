import { describe, expect, it } from "vitest";

import { extractReadPaths } from "../../src/bash";

describe("extractReadPaths", () => {
	it("returns the file of a plain cat", () => {
		expect(extractReadPaths("cat notes.txt")).toEqual(["notes.txt"]);
	});

	it("returns all files of a multi-file cat", () => {
		expect(extractReadPaths("cat a.txt b.txt")).toEqual(["a.txt", "b.txt"]);
	});

	it("skips flags of whole-file readers", () => {
		expect(extractReadPaths("head -n 5 notes.txt")).toEqual([
			"5",
			"notes.txt",
		]);
		expect(extractReadPaths("tail -f log.txt")).toEqual(["log.txt"]);
		expect(extractReadPaths("bat --style=plain notes.txt")).toEqual([
			"notes.txt",
		]);
	});

	it("treats the first grep operand as the pattern", () => {
		expect(extractReadPaths("grep stale notes.txt")).toEqual(["notes.txt"]);
		expect(extractReadPaths("grep -n stale notes.txt")).toEqual([
			"notes.txt",
		]);
		expect(extractReadPaths("rg 'todo' src/index.ts")).toEqual([
			"src/index.ts",
		]);
	});

	it("handles quoted paths", () => {
		expect(extractReadPaths("cat 'my file.txt'")).toEqual(["my file.txt"]);
		expect(extractReadPaths('grep "stale text" "my file.txt"')).toEqual([
			"my file.txt",
		]);
	});

	it("handles escaped spaces in paths", () => {
		expect(extractReadPaths("cat my\\ file.txt")).toEqual(["my file.txt"]);
	});

	it("skips environment assignments before the command", () => {
		expect(extractReadPaths("LC_ALL=C cat notes.txt")).toEqual([
			"notes.txt",
		]);
	});

	it("extracts reads from sequential segments", () => {
		expect(extractReadPaths("cat a.txt && cat b.txt")).toEqual([
			"a.txt",
			"b.txt",
		]);
		expect(extractReadPaths("cat a.txt; grep x b.txt")).toEqual([
			"a.txt",
			"b.txt",
		]);
	});

	it("ignores non-reading commands", () => {
		expect(extractReadPaths("rm notes.txt")).toEqual([]);
		expect(extractReadPaths("sed -n '1p' notes.txt")).toEqual([]);
		expect(extractReadPaths("echo hello")).toEqual([]);
		expect(extractReadPaths("")).toEqual([]);
	});

	it("ignores pipes and redirects", () => {
		expect(extractReadPaths("cat notes.txt | wc -l")).toEqual([]);
		expect(extractReadPaths("cat notes.txt > copy.txt")).toEqual([]);
		expect(extractReadPaths("grep x notes.txt | head")).toEqual([]);
		expect(extractReadPaths("cat notes.txt 2>err.txt")).toEqual([]);
	});

	it("ignores commands with substitutions or backgrounding", () => {
		expect(extractReadPaths("cat $(find . -name x)")).toEqual([]);
		expect(extractReadPaths("cat `ls`")).toEqual([]);
		expect(extractReadPaths("cat $FILE")).toEqual([]);
		expect(extractReadPaths("cat notes.txt &")).toEqual([]);
	});

	it("ignores unterminated quotes", () => {
		expect(extractReadPaths("cat 'notes.txt")).toEqual([]);
	});

	it("ignores unknown commands that look like reads", () => {
		expect(extractReadPaths("catter notes.txt")).toEqual([]);
	});
});
