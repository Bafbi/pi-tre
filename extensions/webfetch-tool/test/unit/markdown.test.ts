import { describe, expect, test } from "vitest";

import { deterministicTextMarkdown, shouldUseSubagentConversion } from "../../src/markdown.js";

describe("markdown conversion strategy", () => {
	test("uses deterministic code fence for shell scripts", () => {
		const body = "#!/bin/sh\nssh exe.dev </dev/tty\n";
		const markdown = deterministicTextMarkdown(body, "text/x-shellscript");

		expect(markdown).toBe("```sh\n#!/bin/sh\nssh exe.dev </dev/tty\n```");
	});

	test("uses subagent only for html-like documents", () => {
		expect(shouldUseSubagentConversion("text/html", "<html><body>ok</body></html>")).toBe(true);
		expect(shouldUseSubagentConversion("text/x-shellscript", "#!/bin/sh\necho hi\n")).toBe(false);
	});
});
