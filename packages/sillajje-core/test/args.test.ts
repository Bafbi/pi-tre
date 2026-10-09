/**
 * The shared argument parser: one rule set and one help convention for
 * every subcommand.
 */

import { describe, expect, it } from "vitest";
import {
	type CommandSpec,
	FOLD_ARGS,
	parseCommandArgs,
	renderHelp,
	renderSessionFailure,
	STAMP_ARGS,
	STAMP_HELP,
} from "../src/index.js";

/** A sync-shaped spec: `-s` optional, `-o` required. */
const SYNC_ARGS: CommandSpec = {
	name: "sync",
	usage: "sync [-s|--session <id>] -o|--onto <rev>",
	flags: [
		{ key: "session", aliases: ["-s", "--session"], takesValue: true },
		{ key: "onto", aliases: ["-o", "--onto"], takesValue: true },
	],
	required: ["onto"],
};

/** A fold-shaped spec: exclusive targets, required `-o`, boolean flags. */
const FOLD_SHAPED_ARGS: CommandSpec = {
	name: "fold",
	usage: "fold (-s <id|@> | -r <rev>) -o <rev>",
	flags: [
		{ key: "session", aliases: ["-s", "--session"], takesValue: true },
		{ key: "rev", aliases: ["-r", "--rev"], takesValue: true },
		{ key: "onto", aliases: ["-o", "--onto"], takesValue: true },
		{ key: "archive", aliases: ["--archive"], takesValue: false },
		{ key: "land", aliases: ["--land"], takesValue: false },
	],
	required: ["onto"],
	exclusive: [["session", "rev"]],
};

/** A repeatable flag, used to pin the collection rules. */
const REPEATABLE_ARGS: CommandSpec = {
	name: "fold",
	usage: "fold --exclude <path>",
	flags: [
		{
			key: "exclude",
			aliases: ["--exclude"],
			takesValue: true,
			repeatable: true,
		},
	],
};

describe("parseCommandArgs", () => {
	it("keeps the command spelling out of the usage line", () => {
		expect(STAMP_ARGS.usage).toBe(
			"stamp [-r|--rev <rev>] [-s|--session <id>]",
		);
	});

	it("parses a value flag with its long and short aliases", () => {
		expect(parseCommandArgs("--rev abc123", STAMP_ARGS)).toEqual({
			kind: "go",
			values: { rev: "abc123" },
		});
		expect(parseCommandArgs("-r abc123", STAMP_ARGS)).toEqual({
			kind: "go",
			values: { rev: "abc123" },
		});
	});

	it("parses the session flag", () => {
		expect(parseCommandArgs("-s @", STAMP_ARGS)).toEqual({
			kind: "go",
			values: { session: "@" },
		});
	});

	it("keeps the last value when a flag repeats", () => {
		expect(parseCommandArgs("--rev a --rev b", STAMP_ARGS)).toEqual({
			kind: "go",
			values: { rev: "b" },
		});
	});

	it("collects a repeatable flag's values in order", () => {
		expect(
			parseCommandArgs("--exclude a --exclude b", REPEATABLE_ARGS),
		).toEqual({ kind: "go", values: { exclude: ["a", "b"] } });
	});

	it("gives a repeatable flag one element per occurrence", () => {
		expect(parseCommandArgs("--exclude a", REPEATABLE_ARGS)).toEqual({
			kind: "go",
			values: { exclude: ["a"] },
		});
	});

	it("rejects a repeatable flag missing its value", () => {
		expect(parseCommandArgs("--exclude", REPEATABLE_ARGS)).toEqual({
			kind: "error",
			message:
				"usage: fold --exclude <path> (--exclude requires a value)",
		});
	});

	it("parses an optional-value flag with and without a value", () => {
		const spec: CommandSpec = {
			name: "fold",
			usage: "fold --name [<branch>] --land",
			flags: [
				{ key: "name", aliases: ["--name"], takesValue: "optional" },
				{ key: "land", aliases: ["--land"], takesValue: false },
			],
		};
		expect(parseCommandArgs("--name review/feat", spec)).toEqual({
			kind: "go",
			values: { name: "review/feat" },
		});
		expect(parseCommandArgs("--name --land", spec)).toEqual({
			kind: "go",
			values: { name: "", land: true },
		});
		expect(parseCommandArgs("--name", spec)).toEqual({
			kind: "go",
			values: { name: "" },
		});
	});

	it("tokenizes on any whitespace", () => {
		expect(parseCommandArgs("  --rev\tabc123  ", STAMP_ARGS)).toEqual({
			kind: "go",
			values: { rev: "abc123" },
		});
	});

	it("renders the usage line with the caller's prefix", () => {
		expect(
			parseCommandArgs("--wat abc", STAMP_ARGS, { prefix: "/sillajje:" }),
		).toEqual({
			kind: "error",
			message:
				'usage: /sillajje:stamp [-r|--rev <rev>] [-s|--session <id>] (unknown flag "--wat")',
		});
	});

	it("renders a prefixless usage when no prefix is given", () => {
		expect(parseCommandArgs("--wat abc", STAMP_ARGS)).toEqual({
			kind: "error",
			message:
				'usage: stamp [-r|--rev <rev>] [-s|--session <id>] (unknown flag "--wat")',
		});
	});

	it("rejects an unknown flag, naming it and the usage", () => {
		const result = parseCommandArgs("--wat abc", STAMP_ARGS, {
			prefix: "/sillajje:",
		});
		expect(result).toEqual({
			kind: "error",
			message:
				'usage: /sillajje:stamp [-r|--rev <rev>] [-s|--session <id>] (unknown flag "--wat")',
		});
	});

	it("rejects a flag missing its value", () => {
		const result = parseCommandArgs("--rev", STAMP_ARGS, {
			prefix: "/sillajje:",
		});
		expect(result).toEqual({
			kind: "error",
			message:
				"usage: /sillajje:stamp [-r|--rev <rev>] [-s|--session <id>] (--rev requires a value)",
		});
	});

	it("rejects a stray positional", () => {
		const result = parseCommandArgs("abc123", STAMP_ARGS, {
			prefix: "/sillajje:",
		});
		expect(result).toEqual({
			kind: "error",
			message:
				'usage: /sillajje:stamp [-r|--rev <rev>] [-s|--session <id>] (unexpected argument "abc123")',
		});
	});

	it("rejects a mutually exclusive pair", () => {
		const result = parseCommandArgs("-r abc -s other", STAMP_ARGS);
		expect(result.kind).toBe("error");
		if (result.kind === "error") {
			expect(result.message).toContain("mutually exclusive");
			expect(result.message).toContain("--rev");
			expect(result.message).toContain("--session");
		}
	});

	it("returns help for -h, --help, and a target-less invocation", () => {
		expect(parseCommandArgs("-h", STAMP_ARGS)).toEqual({ kind: "help" });
		expect(parseCommandArgs("--help", STAMP_ARGS)).toEqual({
			kind: "help",
		});
		expect(parseCommandArgs("", STAMP_ARGS)).toEqual({ kind: "help" });
		expect(parseCommandArgs("   ", STAMP_ARGS)).toEqual({ kind: "help" });
	});

	it("lets help win over an invalid rest", () => {
		expect(parseCommandArgs("--rev -h", STAMP_ARGS)).toEqual({
			kind: "help",
		});
		expect(parseCommandArgs("-r x -s y --help", STAMP_ARGS)).toEqual({
			kind: "help",
		});
	});

	it("rejects a missing required flag", () => {
		const result = parseCommandArgs("-s @", SYNC_ARGS, {
			prefix: "/sillajje:",
		});
		expect(result).toEqual({
			kind: "error",
			message:
				"usage: /sillajje:sync [-s|--session <id>] -o|--onto <rev> (missing --onto)",
		});
	});

	it("parses boolean flags", () => {
		expect(
			parseCommandArgs("--archive --land -o main", FOLD_SHAPED_ARGS),
		).toEqual({
			kind: "go",
			values: { archive: true, land: true, onto: "main" },
		});
	});

	it("parses a fold target and onto", () => {
		expect(
			parseCommandArgs("-s @ -o main --land", FOLD_SHAPED_ARGS),
		).toEqual({
			kind: "go",
			values: { session: "@", onto: "main", land: true },
		});
	});
});

describe("FOLD_ARGS", () => {
	it("accepts a repeatable --exclude beside a target", () => {
		expect(
			parseCommandArgs(
				"-r feat -o main --exclude .scratch/ --exclude tools/",
				FOLD_ARGS,
			),
		).toEqual({
			kind: "go",
			values: {
				rev: "feat",
				onto: "main",
				exclude: [".scratch/", "tools/"],
			},
		});
	});

	it("accepts --rebase with its revision", () => {
		expect(
			parseCommandArgs("-r feat -o main --rebase @", FOLD_ARGS),
		).toEqual({
			kind: "go",
			values: { rev: "feat", onto: "main", rebase: "@" },
		});
	});

	it("rejects a bare --rebase", () => {
		expect(parseCommandArgs("-r feat -o main --rebase", FOLD_ARGS)).toEqual(
			{
				kind: "error",
				message: expect.stringContaining("--rebase requires a value"),
			},
		);
	});
});

describe("renderHelp", () => {
	it("renders the usage line, a blank line, then the help lines", () => {
		expect(renderHelp(STAMP_HELP, "/sillajje:")).toBe(
			[
				"usage: /sillajje:stamp [-r|--rev <rev>] [-s|--session <id>]",
				"",
				"Seals a change with a generated commit message. Exactly one target is required:",
				"  -r, --rev <rev>     describe the revision; no bookmark, no new change",
				"  -s, --session <id>  seal a session's working copy; @ means this session",
				"  -h, --help          show this help",
			].join("\n"),
		);
	});
});

describe("renderSessionFailure", () => {
	it("renders the not-a-session reason", () => {
		expect(renderSessionFailure("not-a-session", "ghost")).toBe(
			"session ghost is not a sillajje session — no sillajje bookmark",
		);
	});

	it("renders the foreign reason", () => {
		expect(renderSessionFailure("foreign", "other")).toBe(
			"session other belongs to another owner — it cannot be used here",
		);
	});

	it("renders the archived reason", () => {
		expect(renderSessionFailure("archived", "old")).toBe(
			"session old is archived — unarchive it first",
		);
	});
});
