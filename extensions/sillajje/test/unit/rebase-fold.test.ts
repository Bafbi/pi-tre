import { describe, expect, it } from "vitest";

import { parseRebaseFoldArgs } from "../../src/rebase-fold";

// ---------------------------------------------------------------------------
// parseRebaseFoldArgs — extracts the positional <rev> and optional
// `--session <id>` from the /sillajje rebase|fold args string.
// Pure function, tested in isolation.
// ---------------------------------------------------------------------------

describe("parseRebaseFoldArgs", () => {
	it("extracts the first positional token as rev", () => {
		expect(parseRebaseFoldArgs("main")).toEqual({ rev: "main" });
	});

	it("extracts rev and --session when both are present", () => {
		expect(parseRebaseFoldArgs("main --session abc123")).toEqual({
			rev: "main",
			sessionId: "abc123",
		});
	});

	it("returns sessionId undefined when --session is absent", () => {
		const result = parseRebaseFoldArgs("main");
		expect(result.sessionId).toBeUndefined();
	});

	it("returns an empty rev when only a --session flag is given", () => {
		expect(parseRebaseFoldArgs("--session abc123")).toEqual({
			rev: "",
			sessionId: "abc123",
		});
	});

	it("finds rev after a leading --session flag", () => {
		expect(parseRebaseFoldArgs("--session abc123 main")).toEqual({
			rev: "main",
			sessionId: "abc123",
		});
	});

	it("returns an empty rev for an empty string", () => {
		expect(parseRebaseFoldArgs("")).toEqual({ rev: "" });
	});

	it("returns an empty rev for whitespace-only input", () => {
		expect(parseRebaseFoldArgs("   \t  \n ")).toEqual({ rev: "" });
	});

	it("trims extra whitespace around tokens", () => {
		expect(parseRebaseFoldArgs("  main  ")).toEqual({ rev: "main" });
	});

	it("splits on any whitespace, including tabs and newlines", () => {
		expect(parseRebaseFoldArgs("main\t--session\nabc123")).toEqual({
			rev: "main",
			sessionId: "abc123",
		});
	});

	it("ignores unknown flags", () => {
		expect(parseRebaseFoldArgs("--unknown main")).toEqual({ rev: "main" });
		expect(parseRebaseFoldArgs("main --unknown --another")).toEqual({
			rev: "main",
		});
	});

	it("uses the last occurrence when --session is repeated", () => {
		expect(
			parseRebaseFoldArgs("main --session first --session second"),
		).toEqual({
			rev: "main",
			sessionId: "second",
		});
	});

	it("ignores extra positional tokens after rev", () => {
		expect(parseRebaseFoldArgs("main extra tokens")).toEqual({
			rev: "main",
		});
	});

	it("ignores a trailing --session with no value", () => {
		expect(parseRebaseFoldArgs("main --session")).toEqual({ rev: "main" });
	});
});
