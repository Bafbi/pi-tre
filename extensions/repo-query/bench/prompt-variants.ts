import { buildSystemPrompt } from "../src/prompt.ts";
import type { ParsedRepo } from "../src/types.ts";

/**
 * One candidate prompt set.
 *
 * `buildSystemPrompt` is the whole child-facing prompt: the instructions and
 * the findings-block request. It takes the same arguments as the production
 * builder so a variant can be dropped in without touching the harness.
 */
export interface PromptVariant {
	id: string;
	description: string;
	buildSystemPrompt(
		repos: ParsedRepo[],
		query: string,
		isSingle: boolean,
	): string;
}

/**
 * The baseline. It calls the production builders, so a wording change in
 * `src/prompt.ts` moves the baseline with it and cannot drift silently.
 */
const v0: PromptVariant = {
	id: "v0",
	description: "Current prompts from src/prompt.ts",
	buildSystemPrompt: (repos, query, isSingle) =>
		buildSystemPrompt(repos, query, isSingle),
};

const VARIANTS: Record<string, PromptVariant> = { v0 };

export function getVariant(id: string): PromptVariant {
	const variant = VARIANTS[id];
	if (variant === undefined) {
		throw new Error(
			`Unknown prompt variant "${id}". Known: ${Object.keys(VARIANTS).join(", ")}`,
		);
	}
	return variant;
}
