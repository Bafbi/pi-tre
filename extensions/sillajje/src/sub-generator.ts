/**
 * Sub-generator: spawns headless pi to produce subject line and summary.
 *
 * Spawns `pi -p --no-session -m <model>` via an injected spawn adapter,
 * pipes a mustache-rendered prompt as stdin, and parses the structured
 * output: line 1 → conventional-commit subject, remaining → summary.
 */

import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Adapter for spawning a subprocess with stdin input. */
export type SpawnFn = (
	command: string,
	args: string[],
	input: string,
	timeoutMs?: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface SubGeneratorContext {
	/** Session transcript: user messages + assistant messages (sans tool results). */
	transcript: string;
	/** File diff from `jj diff -r @-`, or empty string. */
	diff: string;
	/** Descriptions of previous sillajje changes for context. */
	previousDescriptions: string[];
}

export interface SubGeneratorResult {
	subject: string;
	summary: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SUBJECT = "chore: agent interaction";
const SUB_GENERATOR_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = "openai/gpt-4o-mini";

// ---------------------------------------------------------------------------
// Prompt template (mustache-style)
// ---------------------------------------------------------------------------

const PROMPT_TEMPLATE = `You are a commit message generator for an AI coding agent.

Given the conversation transcript, file changes, and context below, produce a conventional-commit subject line and a concise summary of what the agent did.

## Conversation

{{transcript}}

## File changes

{{diff}}

## Previous change descriptions

{{prior_descriptions}}

---

Respond with exactly:
Line 1: A conventional commit subject line (max 72 characters, e.g. "feat: add login form" or "fix: handle null pointer")
All subsequent lines: A concise plain-text summary of what the agent changed and why.`;

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * Render the mustache-style prompt template with the given context.
 */
function renderTemplate(ctx: SubGeneratorContext): string {
	const priorText =
		ctx.previousDescriptions.length > 0
			? ctx.previousDescriptions.join("\n")
			: "(none)";

	return PROMPT_TEMPLATE.replace(/\{\{transcript\}\}/g, ctx.transcript)
		.replace(/\{\{diff\}\}/g, ctx.diff || "(no file changes)")
		.replace(/\{\{prior_descriptions\}\}/g, priorText);
}

/**
 * Parse the sub-generator output.
 * First line → subject, remaining lines → summary.
 */
function parseOutput(output: string): {
	subject: string;
	summary: string;
} {
	const trimmed = output.trim();
	if (!trimmed) return { subject: DEFAULT_SUBJECT, summary: "" };

	const firstNewline = trimmed.indexOf("\n");
	if (firstNewline === -1) {
		return { subject: trimmed, summary: "" };
	}

	const subject = trimmed.slice(0, firstNewline).trim();
	const summary = trimmed.slice(firstNewline + 1).trim();
	return { subject, summary };
}

// ---------------------------------------------------------------------------
// Spawn factory
// ---------------------------------------------------------------------------

/**
 * Create a real SpawnFn that spawns a child process with stdin input.
 * Uses Node.js `child_process.spawn` under the hood.
 */
export function createSpawnFn(): SpawnFn {
	return (
		command: string,
		args: string[],
		input: string,
		timeoutMs?: number,
	): Promise<{ code: number; stdout: string; stderr: string }> => {
		return new Promise((resolve, reject) => {
			const proc = spawn(command, args, {
				stdio: ["pipe", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";

			proc.stdout?.on("data", (data: Buffer) => {
				stdout += data.toString();
			});
			proc.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString();
			});

			proc.on("close", (code: number | null) => {
				resolve({ code: code ?? 1, stdout, stderr });
			});
			proc.on("error", reject);

			// Write input to stdin and close.
			if (proc.stdin) {
				proc.stdin.write(input);
				proc.stdin.end();
			}

			// Timeout handler.
			if (timeoutMs !== undefined) {
				const timer = setTimeout(() => {
					proc.kill();
					reject(new Error(`timeout: ${timeoutMs}ms`));
				}, timeoutMs);
				// Clean up timer on process end.
				proc.on("close", () => clearTimeout(timer));
				proc.on("error", () => clearTimeout(timer));
			}
		});
	};
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

/**
 * Generate a commit subject and summary by spawning a headless pi process.
 *
 * @param ctx - Context with transcript, diff, and prior descriptions.
 * @param spawnFn - Adapter for spawning the subprocess (injected for testability).
 * @param model - Model identifier (defaults to config default).
 * @returns Subject and summary. On failure, falls back to placeholder values.
 */
export async function generate(
	ctx: SubGeneratorContext,
	spawnFn: SpawnFn,
	model: string = DEFAULT_MODEL,
): Promise<SubGeneratorResult> {
	const input = renderTemplate(ctx);

	try {
		const result = await spawnFn(
			"pi",
			["-p", "--no-session", "--model", model],
			input,
			SUB_GENERATOR_TIMEOUT_MS,
		);

		if (result.code !== 0) {
			throw new Error(
				`pi -p exited with code ${result.code}: ${result.stderr}`,
			);
		}

		return parseOutput(result.stdout);
	} catch (err) {
		throw new Error(
			`sub-generator failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
