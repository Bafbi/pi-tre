/**
 * Unit tests for the /sillajje stamp argument parser.
 *
 * The parser is pure and unit-tested in isolation, mirroring the
 * rebase/fold parser's documented rules (whitespace tokens, unknown flags
 * ignored, last-flag-wins) plus the stamp-specific rules: short aliases,
 * --rev/--session mutual exclusion, and stray positionals rejected.
 */

import { describe, expect, it } from "vitest";
import { parseStampArgs } from "../../src/stamp-args";

describe("parseStampArgs", () => {
	it("parses --rev with its value", () => {
		expect(parseStampArgs("--rev abc123")).toEqual({
			rev: "abc123",
		});
	});

	it("parses -r as an alias of --rev", () => {
		expect(parseStampArgs("-r abc123")).toEqual({ rev: "abc123" });
	});

	it("parses --session with its value", () => {
		expect(parseStampArgs("--session my-session")).toEqual({
			sessionId: "my-session",
		});
	});

	it("parses -s as an alias of --session", () => {
		expect(parseStampArgs("-s my-session")).toEqual({
			sessionId: "my-session",
		});
	});

	it("rejects --rev and --session together, naming the command form", () => {
		const result = parseStampArgs("--rev abc --session my-session");
		expect(result.error).toBeDefined();
		expect(result.error).toContain("usage: /sillajje stamp");
		expect(result.error).toContain("mutually exclusive");
	});

	it("rejects -r and -s together", () => {
		const result = parseStampArgs("-r abc -s my-session");
		expect(result.error).toBeDefined();
		expect(result.error).toContain("usage: /sillajje stamp");
	});

	it("last --rev wins", () => {
		expect(parseStampArgs("--rev a --rev b")).toEqual({ rev: "b" });
	});

	it("last --session wins", () => {
		expect(parseStampArgs("--session a --session b")).toEqual({
			sessionId: "b",
		});
	});

	it("ignores unknown flags", () => {
		expect(parseStampArgs("--wat --rev abc")).toEqual({ rev: "abc" });
	});

	it("rejects a flag missing its value", () => {
		const result = parseStampArgs("--rev");
		expect(result.error).toBeDefined();
		expect(result.error).toContain("usage: /sillajje stamp");
	});

	it("rejects a stray positional, naming the command form", () => {
		const result = parseStampArgs("abc123");
		expect(result.error).toBeDefined();
		expect(result.error).toContain("usage: /sillajje stamp");
		expect(result.error).toContain('unexpected argument "abc123"');
	});

	it("rejects a positional mixed with flags", () => {
		const result = parseStampArgs("--rev abc extra");
		expect(result.error).toBeDefined();
		expect(result.error).toContain('unexpected argument "extra"');
	});

	it("returns help for empty args (a stamp requires a target)", () => {
		expect(parseStampArgs("")).toEqual({ help: true });
		expect(parseStampArgs("   ")).toEqual({ help: true });
	});

	it("returns help for -h and --help", () => {
		expect(parseStampArgs("-h")).toEqual({ help: true });
		expect(parseStampArgs("--help")).toEqual({ help: true });
	});

	it("lets help win over other flags, even one missing its value", () => {
		expect(parseStampArgs("--rev abc -h")).toEqual({ help: true });
		expect(parseStampArgs("--rev -h")).toEqual({ help: true });
		expect(parseStampArgs("-r x -s y --help")).toEqual({ help: true });
	});

	it("parses -s @ as the current session", () => {
		expect(parseStampArgs("-s @")).toEqual({ sessionId: "@" });
	});

	it("tokenizes on any whitespace", () => {
		expect(parseStampArgs("  --rev\tabc123  ")).toEqual({
			rev: "abc123",
		});
	});
});
