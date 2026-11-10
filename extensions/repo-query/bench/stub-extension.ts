import { appendFileSync, readFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * A stand-in for the repo_query tool, used by the parent-prompt benchmark.
 *
 * It registers the same tool name with prompt text from a variant, returns a
 * fixed string without cloning anything, and records the arguments the parent
 * model chose. Text and output paths come from the environment because a
 * loaded extension gets no arguments.
 *
 *   RQ_BENCH_STUB_PROMPT_FILE   {"description": "...", "promptSnippet": "...", "promptGuidelines": [...]}
 *   RQ_BENCH_STUB_ARGS_FILE     JSONL, one record per call
 */

interface StubPrompt {
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
}

const STUB_RESULT =
	"repo_query stub: the repositories were not cloned. Answer from the request alone.";

function readPrompt(): StubPrompt {
	const path = process.env.RQ_BENCH_STUB_PROMPT_FILE;
	if (path === undefined) {
		throw new Error("RQ_BENCH_STUB_PROMPT_FILE is not set");
	}
	return JSON.parse(readFileSync(path, "utf-8")) as StubPrompt;
}

export default function stubRepoQuery(pi: ExtensionAPI): void {
	const prompt = readPrompt();

	pi.registerTool({
		name: "repo_query",
		label: "Repo Query",
		description: prompt.description,
		promptSnippet: prompt.promptSnippet,
		promptGuidelines: prompt.promptGuidelines,
		parameters: Type.Object({
			query: Type.String({
				description:
					"One concrete question about the repos' code. Name the symbols, files, or behavior to find so the subagent can grep for them.",
			}),
			repos: Type.Array(
				Type.String({
					description:
						"Repository identifiers: 'owner/repo', 'owner/repo:branch', 'https://github.com/org/repo', or 'git@gitlab.com:org/repo.git'. Add ':branch' to pin a branch.",
				}),
				{ minItems: 1, maxItems: 5 },
			),
		}),
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},

		async execute(_toolCallId, params) {
			const argsFile = process.env.RQ_BENCH_STUB_ARGS_FILE;
			if (argsFile !== undefined) {
				appendFileSync(
					argsFile,
					`${JSON.stringify({ query: params.query, repos: params.repos })}\n`,
					"utf-8",
				);
			}
			return {
				content: [{ type: "text", text: STUB_RESULT }],
				details: { stub: true },
			};
		},
	});
}
