import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { CACHE_DIR } from "./clones.ts";

/** The explorer's own limit, so a benchmark cell fails where production would. */
export const RUN_TIMEOUT_MS = 300_000;
/** Grace between SIGTERM and SIGKILL, mirroring the process backend. */
const KILL_GRACE_MS = 5_000;

/**
 * The model that answers, and the model that judges. Different families on
 * purpose: a judge from the child's own family agrees with its mistakes.
 */
export const DEFAULT_MODEL = "opencode-go/mimo-v2.6-flash";
export const DEFAULT_THINKING = "high";
export const DEFAULT_JUDGE_MODEL = "opencode-go/deepseek-v4.1-flash";
export const DEFAULT_JUDGE_THINKING = "high";

/** Read-only toolset, matching EXPLORER_TOOLS in src/explorer.ts. */
export const EXPLORER_TOOLS = "read,grep,find,ls,bash";

export interface ToolCall {
	name: string;
	args: Record<string, unknown>;
}

interface ToolCallCounts {
	total: number;
	byName: Record<string, number>;
}

export interface RunMetrics {
	/**
	 * Prompt tokens of the first assistant message: `input + cacheRead +
	 * cacheWrite`. `input` alone drops whatever the provider served from its
	 * cache, which would understate the cost of a shared prefix.
	 */
	promptTokens: number;
	turns: number;
	toolCalls: ToolCallCounts;
	/** Every tool call in order, with its arguments. */
	calls: ToolCall[];
	/** Characters the child received from tool results. */
	toolResultChars: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens. */
	billedTokens: number;
	/** Provider-reported cost in USD, summed over assistant messages. */
	costUsd: number;
	/**
	 * sha256 of the base pi system prompt the child received: every section
	 * except the addendum, which is the prompt under test.
	 */
	basePromptHash: string;
	/** Characters of appended prompt (the addendum) the child received. */
	addendumChars: number;
	wallMs: number;
	answer: string;
	exitCode: number | null;
	error: string | null;
}

export interface RunChildOptions {
	/** Appended system prompt. Written to a temp file, never passed inline. */
	systemPrompt: string;
	/** The task the child answers. Sent as `Task: <query>`. */
	query: string;
	/** A prepared clone directory. */
	cwd: string;
	model: string;
	thinking: string;
	/** Where to keep the raw JSONL stream. */
	jsonlPath: string;
	timeoutMs?: number;
}

interface ParsedRun {
	promptTokens: number;
	assistantMessages: number;
	turns: number;
	toolCalls: ToolCallCounts;
	calls: ToolCall[];
	toolResultChars: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	answer: string;
	llmError: string | null;
	basePromptHash: string;
	addendumChars: number;
}

function newParsedRun(): ParsedRun {
	return {
		promptTokens: 0,
		assistantMessages: 0,
		turns: 0,
		toolCalls: { total: 0, byName: {} },
		calls: [],
		toolResultChars: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		answer: "",
		llmError: null,
		basePromptHash: "",
		addendumChars: 0,
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function numberOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Text of a content array, joined the way the subagent accumulator does. */
function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: string; text: string } =>
				asRecord(part)?.type === "text" &&
				typeof asRecord(part)?.text === "string",
		)
		.map((part) => part.text)
		.join("");
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Sections that are prompt under test or per-run metadata, not the base. */
const EXCLUDED_SECTIONS = ["addendum", "cwd"];

/**
 * Hash the base prompt the child was given.
 *
 * pi reports its system message as labelled sections. `addendum` is the prompt
 * we are measuring, and `cwd` names the clone directory, which differs between
 * a cell and its floor run. Neither is part of pi's own prompt, so both are
 * excluded: the hash must move when pi's prompt or tool list changes, and stay
 * put when our prompt changes or the run lands in another directory.
 */
function basePromptOf(sections: Record<string, unknown>): {
	hash: string;
	addendumChars: number;
} {
	const keys = Object.keys(sections)
		.filter((key) => !EXCLUDED_SECTIONS.includes(key))
		.sort();
	const parts = keys.map((key) => `${key}=${String(sections[key])}`);
	const addendum = sections.addendum;
	return {
		hash: sha256(parts.join("\n")),
		addendumChars: typeof addendum === "string" ? addendum.length : 0,
	};
}

/** Fold one JSONL event into the running metrics. */
function consumeEvent(event: Record<string, unknown>, run: ParsedRun): void {
	if (event.type === "turn_end") {
		run.turns++;
		return;
	}

	if (event.type === "tool_execution_start") {
		const name =
			typeof event.toolName === "string" ? event.toolName : "unknown";
		run.toolCalls.total++;
		run.toolCalls.byName[name] = (run.toolCalls.byName[name] ?? 0) + 1;
		run.calls.push({ name, args: asRecord(event.args) ?? {} });
		return;
	}

	if (event.type === "tool_execution_end") {
		const result = asRecord(event.result);
		run.toolResultChars += textOf(result?.content).length;
		return;
	}

	if (event.type === "message_start") {
		const message = asRecord(event.message);
		if (message?.role === "system") {
			const sections = asRecord(message.sections);
			if (sections !== undefined && run.basePromptHash === "") {
				const base = basePromptOf(sections);
				run.basePromptHash = base.hash;
				run.addendumChars = base.addendumChars;
			}
		}
		return;
	}

	if (event.type !== "message_end") return;
	const message = asRecord(event.message);
	if (message?.role !== "assistant") return;

	const usage = asRecord(message.usage);
	run.assistantMessages++;
	// The first assistant message carries the whole prompt: base pi prompt,
	// tool definitions, our appended prompt, and the task.
	if (run.assistantMessages === 1) {
		run.promptTokens =
			numberOf(usage?.input) +
			numberOf(usage?.cacheRead) +
			numberOf(usage?.cacheWrite);
	}
	run.inputTokens += numberOf(usage?.input);
	run.outputTokens += numberOf(usage?.output);
	run.cacheReadTokens += numberOf(usage?.cacheRead);
	run.cacheWriteTokens += numberOf(usage?.cacheWrite);
	run.costUsd += numberOf(asRecord(usage?.cost)?.total);

	const text = textOf(message.content);
	if (text.length > 0) run.answer = text;

	if (message.stopReason === "error") {
		run.llmError =
			typeof message.errorMessage === "string"
				? message.errorMessage
				: "unknown provider error";
	}
}

/**
 * Run one child pi process over a prepared clone and collect its metrics.
 *
 * The system prompt goes through a temp file because it is long and carries
 * backticks; `--append-system-prompt` keeps it out of the command line. stdout
 * is split on LF only, per the JSON-mode contract.
 */
export async function runChild(options: RunChildOptions): Promise<RunMetrics> {
	const {
		systemPrompt,
		query,
		cwd,
		model,
		thinking,
		jsonlPath,
		timeoutMs = RUN_TIMEOUT_MS,
	} = options;

	await mkdir(dirname(jsonlPath), { recursive: true });
	await rm(jsonlPath, { force: true });

	const promptFile = `${jsonlPath}.prompt.txt`;
	await writeFile(promptFile, systemPrompt, "utf-8");

	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-mcp",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--tools",
		EXPLORER_TOOLS,
		"--model",
		model,
		"--thinking",
		thinking,
		"--append-system-prompt",
		promptFile,
		`Task: ${query}`,
	];

	const run = newParsedRun();
	const raw: string[] = [];
	const startedAt = Date.now();

	const exitCode = await new Promise<number | null>((resolve) => {
		const child = spawn(process.env.PI_BIN ?? "pi", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});

		const stdoutDecoder = new StringDecoder("utf8");
		let buffer = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;

		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			if (graceTimer !== undefined) clearTimeout(graceTimer);
			resolve(timedOut ? -1 : code);
		};

		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			graceTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
		}, timeoutMs);

		const handleLine = (line: string) => {
			if (line.trim().length === 0) return;
			raw.push(line);
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			const record = asRecord(event);
			if (record !== undefined) consumeEvent(record, run);
		};

		child.stdout.on("data", (data: Buffer) => {
			buffer += stdoutDecoder.write(data);
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});

		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString("utf8");
		});

		child.on("close", (code) => {
			buffer += stdoutDecoder.end();
			if (buffer.trim().length > 0) handleLine(buffer);
			run.llmError ??= stderrExtract(stderr);
			finish(code);
		});

		child.on("error", (err) => {
			run.llmError = `failed to spawn pi: ${err.message}`;
			finish(null);
		});
	});

	await writeFile(
		jsonlPath,
		raw.length > 0 ? `${raw.join("\n")}\n` : "",
		"utf-8",
	);

	const wallMs = Date.now() - startedAt;
	let error: string | null = null;
	if (exitCode === -1) {
		error = `timed out after ${timeoutMs} ms`;
	} else if (run.llmError !== null) {
		error = run.llmError;
	} else if (exitCode !== 0) {
		error = `child exited with code ${exitCode}`;
	} else if (run.assistantMessages === 0) {
		error = "child produced no assistant message";
	} else if (run.answer.length === 0) {
		error = "child produced an empty answer";
	}

	return {
		promptTokens: run.promptTokens,
		turns: run.turns,
		toolCalls: run.toolCalls,
		calls: run.calls,
		toolResultChars: run.toolResultChars,
		inputTokens: run.inputTokens,
		outputTokens: run.outputTokens,
		cacheReadTokens: run.cacheReadTokens,
		cacheWriteTokens: run.cacheWriteTokens,
		billedTokens:
			run.inputTokens +
			run.outputTokens +
			run.cacheReadTokens +
			run.cacheWriteTokens,
		costUsd: run.costUsd,
		basePromptHash: run.basePromptHash,
		addendumChars: run.addendumChars,
		wallMs,
		answer: run.answer,
		exitCode,
		error,
	};
}

/** Keep the last diagnostic line of stderr; the full stream is noisy. */
function stderrExtract(stderr: string): string | null {
	const lines = stderr
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && /error|refus|denied/i.test(line));
	const last = lines.at(-1);
	return last === undefined ? null : last.slice(0, 300);
}

let cachedPiVersion: string | null = null;

/** The installed pi version, recorded with every cell. */
export function piVersion(): string {
	if (cachedPiVersion !== null) return cachedPiVersion;
	try {
		cachedPiVersion = execFileSync(
			process.env.PI_BIN ?? "pi",
			["--version"],
			{
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			},
		).trim();
	} catch {
		cachedPiVersion = "unknown";
	}
	return cachedPiVersion;
}

/** sha256 of the child's tool allowlist: part of what the base prompt costs. */
export function toolListHash(): string {
	return sha256(EXPLORER_TOOLS);
}

/** The floor key: everything that changes the base prompt cost. */
export interface FloorKey {
	repos: string[];
	query: string;
	model: string;
	thinking: string;
	/** pi version, so an upgrade re-measures instead of reusing a stale floor. */
	piVersion: string;
	/** Tool allowlist hash: adding a tool grows the first-turn prompt. */
	toolListHash: string;
	/** Base prompt hash observed in a real cell of this run. */
	basePromptHash: string;
}

function floorPath(key: FloorKey): string {
	const hash = sha256(JSON.stringify(key)).slice(0, 16);
	return join(CACHE_DIR, `floor-${hash}.json`);
}

/**
 * Token cost of the prompt with a one-character appended prompt.
 *
 * Subtracting it from a real run's `promptTokens` isolates the tokens our
 * prompt costs, measured by the provider's own tokenizer rather than an
 * estimate. One floor run per repository set, task, model, thinking level, pi
 * version, tool list, and base prompt, cached on disk so repeated runs pay
 * nothing.
 *
 * Callers pass the base prompt hash observed in a real cell, so an upgrade that
 * keeps the version string still misses the cache instead of reusing a floor
 * measured against a different base prompt.
 */
export async function ensureFloorTokens(
	key: FloorKey,
	runFloor: () => Promise<RunMetrics>,
): Promise<{ tokens: number; cached: boolean }> {
	const path = floorPath(key);
	if (existsSync(path)) {
		const stored = JSON.parse(await readFile(path, "utf-8")) as {
			tokens: number;
			basePromptHash: string;
		};
		if (stored.basePromptHash === key.basePromptHash) {
			return { tokens: stored.tokens, cached: true };
		}
	}

	const metrics = await runFloor();
	if (metrics.error !== null) {
		throw new Error(`floor run failed: ${metrics.error}`);
	}
	if (
		key.basePromptHash !== "" &&
		metrics.basePromptHash !== "" &&
		metrics.basePromptHash !== key.basePromptHash
	) {
		throw new Error(
			`floor run saw a different base prompt (${metrics.basePromptHash.slice(0, 12)} vs ${key.basePromptHash.slice(0, 12)}); the measured cells are not comparable`,
		);
	}
	await mkdir(CACHE_DIR, { recursive: true });
	await writeFile(
		path,
		`${JSON.stringify(
			{
				key,
				tokens: metrics.promptTokens,
				basePromptHash: metrics.basePromptHash,
			},
			null,
			"\t",
		)}\n`,
		"utf-8",
	);
	return { tokens: metrics.promptTokens, cached: false };
}
