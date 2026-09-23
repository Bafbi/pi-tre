import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
	conflictsArgv,
	diffArgv,
	logArgv,
	mutationArgv,
	NOTHING_CHANGED,
	parsePrintedOpId,
	workspacesArgv,
} from "../src/argv.js";

const fixture = (name: string): string =>
	readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");

describe("mutationArgv", () => {
	it("describes a revision", () => {
		expect(
			mutationArgv({ kind: "describe", rev: "@", message: "body" }),
		).toEqual(["describe", "-r", "@", "-m", "body"]);
	});

	it("creates a new change, passing revs and --no-edit", () => {
		expect(mutationArgv({ kind: "new" })).toEqual(["new"]);
		expect(mutationArgv({ kind: "new", revs: ["abc"] })).toEqual([
			"new",
			"abc",
		]);
		expect(
			mutationArgv({ kind: "new", revs: ["abc"], edit: false }),
		).toEqual(["new", "abc", "--no-edit"]);
	});

	it("sets a bookmark", () => {
		expect(
			mutationArgv({ kind: "bookmarkSet", name: "sillajje/x", rev: "@" }),
		).toEqual(["bookmark", "set", "sillajje/x", "-r", "@"]);
	});

	it("duplicates a revset onto a destination", () => {
		expect(
			mutationArgv({
				kind: "duplicate",
				revset: "a..b",
				destination: "c",
			}),
		).toEqual(["duplicate", "a..b", "--onto", "c"]);
	});

	it("squashes a range into a change, optional message", () => {
		expect(
			mutationArgv({ kind: "squash", from: "a::b", onto: "c" }),
		).toEqual(["squash", "--from", "a::b", "--into", "c"]);
		expect(
			mutationArgv({
				kind: "squash",
				from: "a::b",
				onto: "c",
				message: "m",
			}),
		).toEqual(["squash", "--from", "a::b", "--into", "c", "-m", "m"]);
	});

	it("rebases with one --onto per target", () => {
		expect(
			mutationArgv({
				kind: "rebase",
				source: "@",
				onto: ["rev", "book"],
			}),
		).toEqual(["rebase", "-s", "@", "-o", "rev", "-o", "book"]);
	});
});

describe("read argv", () => {
	it("reads commits with the JSON template", () => {
		expect(logArgv("all()")).toEqual([
			"log",
			"-r",
			"all()",
			"--no-graph",
			"-T",
			'json(self) ++ "\\n"',
		]);
	});

	it("reads a diff for a revset", () => {
		expect(diffArgv("@")).toEqual(["diff", "-r", "@"]);
	});

	it("reads conflicted paths from the working copy", () => {
		expect(conflictsArgv()).toEqual([
			"file",
			"list",
			"-T",
			'if(conflict, path ++ "\\n")',
		]);
	});

	it("reads conflicted paths at a revset", () => {
		expect(conflictsArgv("conflicts()")).toContain("-r");
	});

	it("reads workspaces as name:root pairs", () => {
		expect(workspacesArgv()).toEqual([
			"workspace",
			"list",
			"-T",
			'name ++ ":" ++ root ++ "\\n"',
		]);
	});
});

describe("parsePrintedOpId", () => {
	it("pins the jj 0.44 printed-operation-id line format", () => {
		const line = fixture("op-id-line.txt");
		// The id itself is random; the line's shape is the fixture's value.
		expect(line).toMatch(
			/--no-integrate-operation was requested: [0-9a-f]{12,}/,
		);
		expect(parsePrintedOpId(line)).toMatch(/^[0-9a-f]{12,}$/);
	});

	it("takes the last match when a stream repeats the notice", () => {
		const output = [
			"Operation left uncommitted because --no-integrate-operation was requested: aaaaaaaaaaaa",
			"Operation left uncommitted because --no-integrate-operation was requested: bbbbbbbbbbbb",
		].join("\n");
		expect(parsePrintedOpId(output)).toBe("bbbbbbbbbbbb");
	});

	it("returns undefined when the notice is absent", () => {
		expect(parsePrintedOpId("Nothing changed.")).toBeUndefined();
	});

	it("recognizes the no-op notice", () => {
		expect(NOTHING_CHANGED).toBe("Nothing changed.");
	});
});
