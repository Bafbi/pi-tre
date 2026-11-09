import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	MAX_OUTPUT_CHARS,
	truncateSubagentOutput,
} from "../../src/answer-text.js";
import { parseFindings } from "../../src/findings.js";
import type { ParsedRepo } from "../../src/types.js";

const tempDirs: string[] = [];

const REPO: ParsedRepo = {
	raw: "owner/repo",
	host: "github",
	cloneUrl: "https://github.com/owner/repo.git",
	branch: null,
	displayName: "owner/repo",
	dirName: "github_owner_repo",
};

const BLOCK = `\`\`\`json
{"findings":[{"repo":"owner/repo","path":"src/a.ts","line":2,"claim":"the answer lives here"}]}
\`\`\``;

/** An answer whose prose alone is longer than the cap. */
function longAnswer(): string {
	const sentence =
		"This sentence exists only to push the answer over the cap. ";
	return `${sentence.repeat(200)}\n\n${BLOCK}`;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("truncateSubagentOutput", () => {
	it("leaves a short answer untouched", () => {
		const answer = `short answer\n\n${BLOCK}`;
		expect(truncateSubagentOutput(answer)).toBe(answer);
	});

	it("keeps the findings block when the prose is cut", () => {
		const answer = longAnswer();
		expect(answer.length).toBeGreaterThan(MAX_OUTPUT_CHARS);

		const truncated = truncateSubagentOutput(answer);
		expect(truncated).toContain("[Answer truncated]");
		expect(truncated.endsWith(BLOCK)).toBe(true);
		// The prose really was cut, not served in full.
		expect(truncated.length).toBeLessThan(answer.length);
	});

	it("still cuts a long answer that has no findings block", () => {
		const answer = "x".repeat(MAX_OUTPUT_CHARS + 100);
		const truncated = truncateSubagentOutput(answer);
		expect(truncated).toBe(
			`${"x".repeat(MAX_OUTPUT_CHARS)}...\n[Answer truncated]`,
		);
	});
});

describe("findings survive the truncation the parent applies", () => {
	it("parses the block from a truncated answer", async () => {
		const tempspace = mkdtempSync(join(tmpdir(), "repo-query-truncation-"));
		tempDirs.push(tempspace);
		mkdirSync(join(tempspace, REPO.dirName, "src"), { recursive: true });
		writeFileSync(
			join(tempspace, REPO.dirName, "src", "a.ts"),
			"line 1\nline 2\nline 3\n",
			"utf8",
		);

		const parsed = await parseFindings(
			truncateSubagentOutput(longAnswer()),
			[REPO],
			tempspace,
		);

		expect(parsed.findings).toHaveLength(1);
		expect(parsed.findings[0]?.path).toBe("src/a.ts");
		expect(parsed.findings[0]?.verified).toBe(true);
		// The block is gone from the prose, so the parent does not read it twice.
		expect(parsed.text).not.toContain('"findings"');
	});
});
