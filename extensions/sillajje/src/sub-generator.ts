/**
 * Sub-generator: two focused headless pi subagents for dual-prefix header
 * and compressed trace, run in-process through `@pi-tre/pi-subagent`.
 *
 * - `generateHeader()`: runs one subagent to produce a dual-prefix
 *   subject line (<interaction-type>/<conventional-commit>: <description>).
 * - `generateTrace()`: runs one subagent to produce a compressed
 *   narrative of the agent's thinking-and-tool loop.
 *
 * Both share an injected `SpawnFn` adapter (test seam) and a retry wrapper
 * that retries up to `maxAttempts` times on failure, with fallback values
 * on total exhaustion.
 */

import {
	createInProcessBackend,
	createSafeAccumulator,
	runSubagent,
	type SubagentBackend,
	type SubagentEvent,
} from "@pi-tre/pi-subagent";
import { deriveSubject } from "./metadata.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Adapter over the subagent backend, shaped like the old subprocess spawn
 * (command, args, stdin input) so call sites and the retry wrapper stay
 * unchanged. It does not spawn a process.
 */
export type SpawnFn = (
	command: string,
	args: string[],
	input: string,
	timeoutMs?: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Legacy CLI arg vector handed to `SpawnFn`. The in-process adapter reads
 * only `--model` and `--no-tools` from it; `-p` and `--no-session` are kept
 * so the adapter matches the old child-process invocation.
 */
function subGeneratorArgs(model: string): string[] {
	return ["-p", "--no-session", "--no-tools", "--model", model];
}

/** First line of a sub-generator's output, trimmed. */
function firstLine(text: string): string {
	const newline = text.indexOf("\n");
	return (newline === -1 ? text : text.slice(0, newline)).trim();
}

export interface SubGeneratorContext {
	/** Session transcript: user messages + assistant messages (sans tool results). */
	transcript: string;
	/** File diff from `jj diff -r @`, or empty string. */
	diff: string;
	/** Descriptions of previous sillajje changes for context. */
	previousDescriptions: string[];
}

export interface HeaderOptions {
	model: string;
	maxAttempts: number;
	timeoutMs: number;
	/** User prompt used as fallback subject on exhaustion. */
	prompt: string;
}

/**
 * Result of a sub-generator call.
 *
 * Carries an explicit `fellBack` flag so callers can detect sub-generator
 * exhaustion without comparing the returned text against a fallback literal
 * (a legitimate output that matches the fallback string must not look like a
 * failure, and renaming a fallback string must not silently disable warnings).
 */
export interface GeneratedText {
	/** The produced text, or the generator's fallback default on exhaustion. */
	text: string;
	/** True when retries were exhausted and the fallback default was returned. */
	fellBack: boolean;
}

export interface TraceOptions {
	model: string;
	maxAttempts: number;
	timeoutMs: number;
	/** Detail level for the trace narrative. */
	detail: "high" | "step" | "decision";
}

// ---------------------------------------------------------------------------
// Prompt templates (mustache-style)
// ---------------------------------------------------------------------------
// Prompt templates (mustache-style)
// ---------------------------------------------------------------------------

const HEADER_PROMPT_TEMPLATE = `## Previous change descriptions

{{prior_descriptions}}

## Conversation

{{transcript}}

## File changes

{{diff}}

---

Produce a single subject line for this interaction.

Format: <interaction-type>[/<conventional-commit>][(<optional-scope>)]: <description>

Interaction types:
- act: The agent executed changes (files were modified)
- plan: The agent designed or scoped something
- explore: The agent read and navigated the codebase
- research: The agent investigated external sources (docs, APIs, repos)
- ask: The agent asked the user a question
- answer: The agent answered the user's question
- debug: The agent diagnosed a problem

Rules:
- The description is a quick overview of the interaction — what the conversation was about — so the user can recognize it at a glance in jj log.
- When files changed, choose a conventional-commit prefix that describes the nature of the changes.
- The optional scope signals which area of the codebase the interaction touched. Infer it from file paths.
- When no files changed, omit the conventional-commit (e.g. "answer: middleware chain explained").

Examples:
  act/feat(auth): add login form
  explore(refactor): audit error handling patterns
  answer: middleware chain explained
  debug(fix): null pointer in auth middleware
  research(docs): REST API pagination patterns
  ask: should we use typebox for this?

Respond with exactly one line, max 72 characters.`;

const TRACE_HIGH_TEMPLATE = `## Previous change descriptions

{{prior_descriptions}}

## Conversation

{{transcript}}

## File changes

{{diff}}

---

Write a 2-4 sentence plain-English narrative of what happened in this interaction.

Rules:
- Capture: what the user asked, what the agent did and why, and the outcome.
- Ground the narrative in the transcript — what the user said and what the agent thought/did — not in the file diff.
- The purpose is to help the user remember the conversation at a glance without re-reading the transcript.

Respond with only the narrative, no labels or prefixes.`;

const TRACE_STEP_TEMPLATE = `## Previous change descriptions

{{prior_descriptions}}

## Conversation

{{transcript}}

## File changes

{{diff}}

---

Write numbered steps describing this interaction.

Rules:
- Each step says what the agent did, what it was thinking, and what tool it used — grounded in the transcript, not in the file diff.
- The purpose is to help the user retrace the agent's process without re-reading the transcript.

Respond with only the numbered steps, no labels or prefixes.`;

const TRACE_DECISION_TEMPLATE = `## Previous change descriptions

{{prior_descriptions}}

## Conversation

{{transcript}}

## File changes

{{diff}}

---

Identify the key decisions made during this interaction.

Rules:
- Focus on what the agent considered, discovered, and decided — grounded in the transcript, not in the file diff.
- Explain why each decision was made and what trade-offs were weighed.
- The purpose is to help the user understand the reasoning behind each choice.

Respond with only the narrative, no labels or prefixes.`;

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

/**
 * Render the mustache-style prompt template with the given context.
 */
function renderTemplate(template: string, ctx: SubGeneratorContext): string {
	const priorText =
		ctx.previousDescriptions.length > 0
			? ctx.previousDescriptions.join("\n")
			: "(none)";

	return template
		.replace(/\{\{transcript\}\}/g, ctx.transcript)
		.replace(/\{\{diff\}\}/g, ctx.diff || "(no file changes)")
		.replace(/\{\{prior_descriptions\}\}/g, priorText);
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

/**
 * Spawn a subprocess via `spawnFn`, with retry logic.
 *
 * Retries up to `maxAttempts` times when:
 * - The process exits with a non-zero code
 * - The process throws (timeout, spawn error)
 * - The output is empty or whitespace-only
 *
 * @returns The trimmed stdout on success.
 * @throws The last error when all attempts are exhausted.
 */
async function spawnWithRetry(
	spawnFn: SpawnFn,
	cmd: string,
	args: string[],
	input: string,
	timeoutMs: number,
	maxAttempts: number,
): Promise<string> {
	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const result = await spawnFn(cmd, args, input, timeoutMs);

			if (result.code !== 0) {
				throw new Error(
					`exited with code ${result.code}: ${result.stderr || "(no stderr)"}`,
				);
			}

			const trimmed = result.stdout.trim();
			if (trimmed.length === 0) {
				throw new Error("empty output");
			}

			return trimmed;
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			// Continue to next attempt
		}
	}

	throw lastError ?? new Error("spawnWithRetry: exhausted without lastError");
}

// ---------------------------------------------------------------------------
// Header sub-generator
// ---------------------------------------------------------------------------

/**
 * Generate a dual-prefix subject line.
 *
 * Spawns `pi -p --no-session --no-tools -m <model>` via the injected
 * `spawnFn`, with a prompt that classifies the interaction type and
 * (when applicable) the conventional-commit prefix.
 *
 * Output parsing: first line of stdout is the subject, rest discarded.
 *
 * On total exhaustion, falls back to `deriveSubject(prompt)`.
 *
 * @param ctx - Context with transcript, diff, and prior descriptions.
 * @param spawnFn - Adapter over the subagent backend (injected for testability).
 * @param options - Model, retry, timeout, and fallback prompt.
 * @returns The subject line (never empty) plus a `fellBack` flag reporting
 * sub-generator exhaustion.
 */
export async function generateHeader(
	ctx: SubGeneratorContext,
	spawnFn: SpawnFn,
	options: HeaderOptions,
): Promise<GeneratedText> {
	const input = renderTemplate(HEADER_PROMPT_TEMPLATE, ctx);

	try {
		const raw = await spawnWithRetry(
			spawnFn,
			"pi",
			subGeneratorArgs(options.model),
			input,
			options.timeoutMs,
			options.maxAttempts,
		);

		// First line is the subject, rest discarded.
		return { text: firstLine(raw), fellBack: false };
	} catch {
		// Fallback to deriveSubject on exhaustion.
		return { text: deriveSubject(options.prompt), fellBack: true };
	}
}

// ---------------------------------------------------------------------------
// Trace sub-generator
// ---------------------------------------------------------------------------

/**
 * Generate a compressed agent-loop narrative (trace).
 *
 * Runs the subagent through the injected `spawnFn`, with a prompt tailored
 * to the requested detail level.
 *
 * Output: entire stdout is the trace (freeform, trimmed).
 *
 * On total exhaustion, returns empty string.
 *
 * @param ctx - Context with transcript, diff, and prior descriptions.
 * @param spawnFn - Adapter over the subagent backend (injected for testability).
 * @param options - Model, retry, timeout, and detail level.
 * @returns The trace narrative (empty string on exhaustion) plus a `fellBack`
 * flag reporting sub-generator exhaustion.
 */
export async function generateTrace(
	ctx: SubGeneratorContext,
	spawnFn: SpawnFn,
	options: TraceOptions,
): Promise<GeneratedText> {
	const template = pickTraceTemplate(options.detail);
	const input = renderTemplate(template, ctx);

	try {
		const raw = await spawnWithRetry(
			spawnFn,
			"pi",
			subGeneratorArgs(options.model),
			input,
			options.timeoutMs,
			options.maxAttempts,
		);

		return { text: raw, fellBack: false };
	} catch {
		// Fallback to empty string on exhaustion.
		return { text: "", fellBack: true };
	}
}

/**
 * Pick the trace prompt template based on the detail level.
 */
function pickTraceTemplate(detail: "high" | "step" | "decision"): string {
	switch (detail) {
		case "high":
			return TRACE_HIGH_TEMPLATE;
		case "step":
			return TRACE_STEP_TEMPLATE;
		case "decision":
			return TRACE_DECISION_TEMPLATE;
	}
}

// ---------------------------------------------------------------------------
// Manual-stamp header sub-generator (classic conventional commit, diff-only)
// ---------------------------------------------------------------------------

/**
 * Prompt template for the manual-stamp header sub-generator.
 * Produces a classic conventional commit from a file diff, without the
 * dual-prefix taxonomy used by the auto-stamp header.
 */
const MANUAL_HEADER_PROMPT_TEMPLATE = `You produce conventional commit messages from file diffs.

Given the file changes below, produce a single commit subject line in conventional commits format.

Format: <type>: <description>

Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert

Examples:
  feat: add user login form
  fix: handle null pointer in auth middleware
  docs: update API reference
  refactor: extract validation logic

Only look at the diff to determine the type and description. Do not ask for clarification.

## File changes

{{diff}}

Respond with exactly one line, max 72 characters.`;

/**
 * Generate a classic conventional commit subject line from the diff alone.
 *
 * Used by the manual stamp command (/sillajje stamp). Spawns a headless
 * pi process to classify the diff and produce a single-line conventional
 * commit subject (e.g. "feat: add user login form").
 *
 * On total exhaustion, falls back to "chore: manual checkpoint".
 *
 * @param diff - The file diff from the workspace working copy.
 * @param spawnFn - Adapter over the subagent backend (injected for testability).
 * @param options - Model, retry, and timeout configuration.
 * @returns The subject line (never empty) plus a `fellBack` flag reporting
 * sub-generator exhaustion.
 */
export async function generateManualHeader(
	diff: string,
	spawnFn: SpawnFn,
	options: { model: string; maxAttempts: number; timeoutMs: number },
): Promise<GeneratedText> {
	const input = MANUAL_HEADER_PROMPT_TEMPLATE.replace(
		/\{\{diff\}\}/g,
		diff || "(no file changes)",
	);

	try {
		const raw = await spawnWithRetry(
			spawnFn,
			"pi",
			subGeneratorArgs(options.model),
			input,
			options.timeoutMs,
			options.maxAttempts,
		);

		return { text: firstLine(raw), fellBack: false };
	} catch {
		return { text: "chore: manual checkpoint", fellBack: true };
	}
}

// ---------------------------------------------------------------------------
// Spawn factory
// ---------------------------------------------------------------------------

/**
 * Create the real SpawnFn used for change stamping.
 *
 * The adapter runs the subagent through `@pi-tre/pi-subagent`'s
 * in-process backend: no child process, no spawn latency across retry
 * attempts. It maps the seam's session events back onto the SpawnFn
 * result shape the retry wrapper expects:
 *
 * - answer text → `stdout`
 * - LLM errors, session-creation failures → non-zero `code` + `stderr`
 * - a timed-out run → non-zero `code`, retried like the old timeout
 *   rejection
 *
 * `backend` is injectable for tests; production uses the in-process
 * backend, which builds its own model runtime from the agent directory.
 */
export function createSpawnFn(backend?: SubagentBackend): SpawnFn {
	const resolved = backend ?? createInProcessBackend();
	return async (
		_command: string,
		args: string[],
		input: string,
		timeoutMs?: number,
	): Promise<{ code: number; stdout: string; stderr: string }> => {
		const modelFlag = args.indexOf("--model");
		const model = modelFlag !== -1 ? args[modelFlag + 1] : undefined;
		// The generator runs tool-less: the old command carried `--no-tools`,
		// and the child must not load installed extensions' tools into the
		// session (recursion guard). An empty allowlist disables all tools,
		// built-in and extension.
		const noTools = args.includes("--no-tools");

		const session = runSubagent(
			{
				prompt: input,
				cwd: process.cwd(),
				model,
				tools: noTools ? [] : undefined,
				timeoutMs,
			},
			resolved,
		);

		const answer = createSafeAccumulator();
		let errorMessage = "";
		let exit: Extract<SubagentEvent, { type: "exit" }> | undefined;

		for await (const event of session.events) {
			switch (event.type) {
				case "text":
					answer.append(event.text, event.kind);
					break;
				case "error":
					errorMessage = event.message;
					break;
				case "exit":
					exit = event;
					break;
				default:
					break;
			}
		}

		// The final assistant text only, matching the old text-mode stdout.
		const stdout = exit?.timedOut || errorMessage ? "" : answer.get();

		if (!exit) {
			return {
				code: 1,
				stdout,
				stderr: errorMessage || "subagent ended without an exit event",
			};
		}
		if (exit.timedOut) {
			return { code: 1, stdout, stderr: `timeout: ${timeoutMs}ms` };
		}
		if (exit.aborted) {
			return { code: 1, stdout, stderr: errorMessage || "aborted" };
		}
		if (exit.code !== 0 || errorMessage) {
			return {
				code: exit.code || 1,
				stdout,
				stderr:
					errorMessage ||
					exit.stderr ||
					exit.spawnError ||
					"subagent failed",
			};
		}
		return { code: 0, stdout, stderr: "" };
	};
}
