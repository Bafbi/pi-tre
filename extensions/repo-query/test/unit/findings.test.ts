import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseFindings } from "../../src/findings.js";
import type { ParsedRepo } from "../../src/types.js";

const tempDirs: string[] = [];

function makeCloneLayout(): {
	tempspace: string;
	repo: ParsedRepo;
	other: ParsedRepo;
} {
	const tempspace = mkdtempSync(join(tmpdir(), "repo-query-findings-"));
	tempDirs.push(tempspace);

	for (const dirName of ["github_owner_repo", "github_owner_other"]) {
		mkdirSync(join(tempspace, dirName, "src"), { recursive: true });
		writeFileSync(
			join(tempspace, dirName, "src", "a.ts"),
			"line 1\nline 2\nline 3\n",
			"utf8",
		);
	}

	return {
		tempspace,
		repo: {
			raw: "owner/repo",
			host: "github",
			cloneUrl: "https://github.com/owner/repo.git",
			branch: null,
			displayName: "owner/repo",
			dirName: "github_owner_repo",
			owner: "owner",
			repo: "repo",
		},
		other: {
			raw: "owner/other",
			host: "github",
			cloneUrl: "https://github.com/owner/other.git",
			branch: null,
			displayName: "owner/other",
			dirName: "github_owner_other",
			owner: "owner",
			repo: "other",
		},
	};
}

function answerWith(findings: unknown): string {
	return `The answer.\n\n\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\``;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("parseFindings", () => {
	it("parses a verified finding and strips the block from the answer", async () => {
		const { tempspace, repo } = makeCloneLayout();

		const result = await parseFindings(
			answerWith([
				{
					repo: "owner/repo",
					path: "src/a.ts",
					line: 2,
					claim: "The second line matters.",
				},
			]),
			[repo],
			tempspace,
		);

		expect(result.text).toBe("The answer.");
		expect(result.findings).toEqual([
			{
				repo: "owner/repo",
				path: "src/a.ts",
				line: 2,
				claim: "The second line matters.",
				verified: true,
			},
		]);
	});

	it("marks a missing file as unverified and keeps the claim", async () => {
		const { tempspace, repo } = makeCloneLayout();

		const result = await parseFindings(
			answerWith([
				{
					repo: "owner/repo",
					path: "src/missing.ts",
					line: 2,
					claim: "Not there.",
				},
			]),
			[repo],
			tempspace,
		);

		expect(result.findings[0]).toMatchObject({
			path: "src/missing.ts",
			verified: false,
		});
	});

	it("marks a line beyond the file as unverified", async () => {
		const { tempspace, repo } = makeCloneLayout();

		const result = await parseFindings(
			answerWith([
				{
					repo: "owner/repo",
					path: "src/a.ts",
					line: 99,
					claim: "Beyond the end.",
				},
			]),
			[repo],
			tempspace,
		);

		expect(result.findings[0]?.verified).toBe(false);
	});

	it("drops a path that escapes the clone", async () => {
		const { tempspace, repo } = makeCloneLayout();

		const result = await parseFindings(
			answerWith([
				{
					repo: "owner/repo",
					path: "../secret.txt",
					line: null,
					claim: "Traversal.",
				},
			]),
			[repo],
			tempspace,
		);

		expect(result.findings).toEqual([]);
		// Every entry was rejected, so the block stays in the answer.
		expect(result.text).toContain("```json");
	});

	it("keeps the block when every entry is rejected", async () => {
		const { tempspace, repo } = makeCloneLayout();
		const answer = answerWith([
			{
				repo: "owner/repo",
				path: "src/a.ts",
				claim: "",
			},
		]);

		const result = await parseFindings(answer, [repo], tempspace);
		expect(result.text).toBe(answer);
		expect(result.findings).toEqual([]);
	});

	it("finds the repository when the model omits it", async () => {
		const { tempspace, repo, other } = makeCloneLayout();

		const result = await parseFindings(
			answerWith([
				{ path: "src/a.ts", line: 1, claim: "No repo given." },
			]),
			[repo, other],
			tempspace,
		);

		expect(result.findings[0]?.repo).toBe("owner/repo");
		expect(result.findings[0]?.verified).toBe(true);
	});

	it("keeps a finding with an unknown named repo unverified", async () => {
		const { tempspace, repo, other } = makeCloneLayout();

		const result = await parseFindings(
			answerWith([
				{
					repo: "owner/unrequested",
					path: "src/a.ts",
					line: 1,
					claim: "Wrong repo.",
				},
			]),
			[repo, other],
			tempspace,
		);

		expect(result.findings[0]).toMatchObject({
			repo: null,
			verified: false,
		});
	});

	it.skipIf(process.platform === "win32")(
		"does not verify a symlink that points outside the clone",
		async () => {
			const { tempspace, repo } = makeCloneLayout();
			const outside = join(tempspace, "outside.ts");
			writeFileSync(outside, "secret\n", "utf8");
			symlinkSync(
				outside,
				join(tempspace, "github_owner_repo", "src", "link.ts"),
			);

			const result = await parseFindings(
				answerWith([
					{
						repo: "owner/repo",
						path: "src/link.ts",
						line: 1,
						claim: "Escapes the clone.",
					},
				]),
				[repo],
				tempspace,
			);

			expect(result.findings[0]?.verified).toBe(false);
		},
	);

	it("does not strip a fenced array that is not findings", async () => {
		const { tempspace, repo } = makeCloneLayout();
		const answer = 'Answer.\n\n```json\n["read", "grep"]\n```';

		const result = await parseFindings(answer, [repo], tempspace);
		expect(result.text).toBe(answer);
		expect(result.findings).toEqual([]);
	});

	it("accepts a bare findings array", async () => {
		const { tempspace, repo } = makeCloneLayout();
		const answer = `Answer.\n\n\`\`\`json\n${JSON.stringify([
			{ repo: "owner/repo", path: "src/a.ts", line: 3, claim: "Bare." },
		])}\n\`\`\``;

		const result = await parseFindings(answer, [repo], tempspace);
		expect(result.findings[0]?.verified).toBe(true);
	});

	it("leaves the answer untouched when the block is malformed", async () => {
		const { tempspace, repo } = makeCloneLayout();
		const answer = "Answer.\n\n```json\n{ not json }\n```";

		const result = await parseFindings(answer, [repo], tempspace);
		expect(result.text).toBe(answer);
		expect(result.findings).toEqual([]);
	});

	it("leaves the answer untouched when there is no block", async () => {
		const { tempspace, repo } = makeCloneLayout();

		const result = await parseFindings("Plain answer.", [repo], tempspace);
		expect(result.text).toBe("Plain answer.");
		expect(result.findings).toEqual([]);
	});

	it("caps the findings at 20", async () => {
		const { tempspace, repo } = makeCloneLayout();
		const entries = Array.from({ length: 25 }, (_, i) => ({
			repo: "owner/repo",
			path: "src/a.ts",
			line: 1,
			claim: `claim ${i}`,
		}));

		const result = await parseFindings(
			answerWith(entries),
			[repo],
			tempspace,
		);
		expect(result.findings).toHaveLength(20);
	});
});
