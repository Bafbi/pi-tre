import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
	REPO_QUERY_DESCRIPTION,
	REPO_QUERY_PROMPT_GUIDELINES,
	REPO_QUERY_PROMPT_SNIPPET,
} from "../src/tool-prompt.ts";
import { BENCH_DIR, RUNS_DIR } from "./clones.ts";
import {
	DEFAULT_MODEL,
	DEFAULT_THINKING,
	piVersion,
	RUN_TIMEOUT_MS,
	toolListHash,
} from "./harness.ts";

/**
 * The parent-facing half of the benchmark: does the tool prompt make a parent
 * agent call repo_query, with the right repositories and a query that names
 * the symbol?
 *
 * The child probe in harness.ts measures what the tool costs the explorer. This
 * one measures what the tool prompt costs the parent and whether it works.
 *
 * Usage:
 *   node bench/parent.ts [--model M] [--thinking LEVEL]
 */

interface ParentTask {
	id: string;
	request: string;
	/** Symbol the query the parent sends must mention. */
	keySymbol: string;
	/** Repository identifiers the parent should pass. */
	repos: string[];
}

const PARENT_TASKS: ParentTask[] = [
	{
		id: "plimit-clear-queue",
		request:
			"I need to know where p-limit's clearQueue gets the error value it rejects the pending tasks with. Look it up in sindresorhus/p-limit.",
		keySymbol: "clearQueue",
		repos: ["sindresorhus/p-limit"],
	},
	{
		id: "pqueue-fifo",
		request:
			"In sindresorhus/p-queue, how does the default priority queue keep tasks with the same priority in the order they were added? Look it up.",
		keySymbol: "priority",
		repos: ["sindresorhus/p-queue"],
	},
	{
		id: "compare-queues",
		request:
			"Compare where sindresorhus/p-limit and sindresorhus/p-queue put a newly queued task. Look both up together.",
		keySymbol: "enqueue",
		repos: ["sindresorhus/p-limit", "sindresorhus/p-queue"],
	},
];

interface StubPrompt {
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
}

/** The current prompt surface, from src/tool-prompt.ts. */
const V0: StubPrompt = {
	description: REPO_QUERY_DESCRIPTION,
	promptSnippet: REPO_QUERY_PROMPT_SNIPPET,
	promptGuidelines: REPO_QUERY_PROMPT_GUIDELINES,
};

/** The floor: a tool with no prompt text at all. */
const EMPTY: StubPrompt = {
	description: "",
	promptSnippet: "",
	promptGuidelines: [],
};

interface Probe {
	promptTokens: number;
	called: boolean;
	repos: string[];
	query: string;
	usedTools: string[];
	answer: string;
	error: string | null;
	wallMs: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

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

/** Run one parent agent with the stub tool and read back what it did. */
async function runProbe(options: {
	prompt: StubPrompt;
	request: string;
	outDir: string;
	label: string;
	model: string;
	thinking: string;
}): Promise<Probe> {
	const { prompt, request, outDir, label, model, thinking } = options;
	const promptFile = join(outDir, `${label}.prompt.json`);
	const argsFile = join(outDir, `${label}.args.jsonl`);
	const jsonlFile = join(outDir, `${label}.jsonl`);
	await writeFile(promptFile, JSON.stringify(prompt), "utf-8");
	await rm(argsFile, { force: true });

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
		"-e",
		join(BENCH_DIR, "stub-extension.ts"),
		"--tools",
		"repo_query",
		"--model",
		model,
		"--thinking",
		thinking,
		request,
	];

	const startedAt = Date.now();
	const lines: string[] = [];
	let assistantMessages = 0;
	let promptTokens = 0;
	let answer = "";
	let error: string | null = null;
	const usedTools: string[] = [];

	const exitCode = await new Promise<number | null>((resolve) => {
		const child = spawn(process.env.PI_BIN ?? "pi", args, {
			cwd: outDir,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
			env: {
				...process.env,
				RQ_BENCH_STUB_PROMPT_FILE: promptFile,
				RQ_BENCH_STUB_ARGS_FILE: argsFile,
			},
		});

		const decoder = new StringDecoder("utf8");
		let buffer = "";
		let stderr = "";
		let settled = false;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;

		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (graceTimer !== undefined) clearTimeout(graceTimer);
			resolve(code);
		};

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			graceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
			error = "timed out";
		}, RUN_TIMEOUT_MS);

		const handleLine = (line: string) => {
			if (line.trim().length === 0) return;
			lines.push(line);
			let event: Record<string, unknown> | undefined;
			try {
				event = asRecord(JSON.parse(line));
			} catch {
				return;
			}
			if (event === undefined) return;
			if (event.type === "tool_execution_start") {
				const name =
					typeof event.toolName === "string" ? event.toolName : "?";
				usedTools.push(name);
			}
			if (event.type !== "message_end") return;
			const message = asRecord(event.message);
			if (message?.role !== "assistant") return;
			assistantMessages++;
			if (assistantMessages === 1) {
				// Same accounting as harness.ts: a cache hit is still prompt.
				const usage = asRecord(message.usage);
				const count = (value: unknown): number =>
					typeof value === "number" && Number.isFinite(value)
						? value
						: 0;
				promptTokens =
					count(usage?.input) +
					count(usage?.cacheRead) +
					count(usage?.cacheWrite);
			}
			const text = textOf(message.content);
			if (text.length > 0) answer = text;
		};

		child.stdout.on("data", (data: Buffer) => {
			buffer += decoder.write(data);
			const parts = buffer.split("\n");
			buffer = parts.pop() ?? "";
			for (const part of parts) handleLine(part);
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString("utf8");
		});
		child.on("close", (code) => {
			buffer += decoder.end();
			if (buffer.trim().length > 0) handleLine(buffer);
			if (error === null && code !== 0) {
				error = `exit ${code}: ${stderr.split("\n").filter(Boolean).at(-1)?.slice(0, 200) ?? ""}`;
			}
			finish(code);
		});
		child.on("error", (spawnError) => {
			error = spawnError.message;
			finish(null);
		});
	});

	await writeFile(
		jsonlFile,
		lines.length > 0 ? `${lines.join("\n")}\n` : "",
		"utf-8",
	);

	const calls = existsSync(argsFile)
		? readFileSync(argsFile, "utf-8")
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map(
					(line) =>
						JSON.parse(line) as { query: string; repos: string[] },
				)
		: [];
	const first = calls[0];

	return {
		promptTokens,
		called: calls.length > 0,
		repos: first?.repos ?? [],
		query: first?.query ?? "",
		usedTools,
		answer,
		error: error ?? (exitCode === null ? "spawn failed" : null),
		wallMs: Date.now() - startedAt,
	};
}

function parseArgs(argv: string[]): { model: string; thinking: string } {
	let model = DEFAULT_MODEL;
	let thinking = DEFAULT_THINKING;
	for (let i = 0; i < argv.length; i++) {
		const value = argv[i + 1];
		if (argv[i] === "--model") {
			if (value === undefined) throw new Error("--model needs a value");
			model = value;
			i++;
		} else if (argv[i] === "--thinking") {
			if (value === undefined)
				throw new Error("--thinking needs a value");
			thinking = value;
			i++;
		} else {
			throw new Error(`Unknown argument: ${argv[i]}`);
		}
	}
	return { model, thinking };
}

function stamp(): string {
	return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
}

async function main(): Promise<number> {
	const { model, thinking } = parseArgs(process.argv.slice(2));
	const date = new Date().toISOString();
	const outDir = join(RUNS_DIR, `parent-${stamp()}`);
	await mkdir(outDir, { recursive: true });

	console.log(
		`parent probe on ${model} (thinking ${thinking}), pi ${piVersion()}`,
	);

	const rows: Array<{
		task: ParentTask;
		v0: Probe;
		floor: Probe;
		repoMatch: boolean;
		symbolMatch: boolean;
		toolPromptTokens: number;
	}> = [];

	for (const task of PARENT_TASKS) {
		const floor = await runProbe({
			prompt: EMPTY,
			request: task.request,
			outDir,
			label: `${task.id}-floor`,
			model,
			thinking,
		});
		const v0 = await runProbe({
			prompt: V0,
			request: task.request,
			outDir,
			label: `${task.id}-v0`,
			model,
			thinking,
		});

		const repoMatch =
			task.repos.length === v0.repos.length &&
			task.repos.every((repo) =>
				v0.repos.some(
					(passed) =>
						passed === repo ||
						passed.replace(/:.*/, "") === repo ||
						passed.includes(repo),
				),
			);
		rows.push({
			task,
			v0,
			floor,
			repoMatch,
			symbolMatch: v0.query
				.toLowerCase()
				.includes(task.keySymbol.toLowerCase()),
			toolPromptTokens: v0.promptTokens - floor.promptTokens,
		});
	}

	const header = [
		"task",
		"called",
		"repos ok",
		"query names symbol",
		"toolPromptTokens",
		"wallMs",
		"error",
	];
	const table = [
		header,
		...rows.map((row) => [
			row.task.id,
			row.v0.called ? "yes" : "no",
			row.repoMatch ? "yes" : `no (${row.v0.repos.join(", ")})`,
			row.symbolMatch ? "yes" : "no",
			String(row.toolPromptTokens),
			String(row.v0.wallMs),
			row.v0.error ?? "",
		]),
	];
	const widths = header.map((_, column) =>
		Math.max(...table.map((line) => (line[column] ?? "").length)),
	);
	for (const line of table) {
		console.log(
			line
				.map((cell, column) => cell.padEnd(widths[column] ?? 0))
				.join("  ")
				.trimEnd(),
		);
	}

	const callRate = rows.filter((row) => row.v0.called).length / rows.length;
	const meanToolTokens =
		rows.reduce((sum, row) => sum + row.toolPromptTokens, 0) / rows.length;

	console.log("");
	console.log(
		`call rate: ${(callRate * 100).toFixed(0)}% of ${rows.length} tasks`,
	);
	console.log(
		`tool prompt cost: ${Math.round(meanToolTokens)} tokens (first-turn prompt tokens minus an empty-description floor, averaged over the tasks)`,
	);
	console.log(`detail: ${outDir}`);

	await writeFile(
		join(outDir, "report.json"),
		`${JSON.stringify(
			{
				// Provenance every results file carries: which model, at which
				// thinking level, on which pi, when.
				model,
				thinking,
				piVersion: piVersion(),
				toolListHash: toolListHash(),
				date,
				judgeModel: null,
				callRate,
				meanToolPromptTokens: meanToolTokens,
				rows,
			},
			null,
			"\t",
		)}\n`,
		"utf-8",
	);

	return 0;
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	},
);
