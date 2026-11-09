import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
	DEFAULT_JUDGE_MODEL,
	DEFAULT_JUDGE_THINKING,
	RUN_TIMEOUT_MS,
} from "./harness.ts";
import { parseFindingsBlock, verifyFindings } from "./score.ts";
import type { LoadedTask } from "./tasks.ts";

/**
 * One LLM judge call per cell, on top of the deterministic score.
 *
 * The judge is a different model family from the child on purpose, gets no
 * tools, and sees one answer with no variant id, so it cannot tell which prompt
 * produced it. It reads the cited source lines from the clone, so it can check
 * grounding without exploring anything itself.
 */

/** Max findings whose source the judge reads. */
const MAX_SOURCE_FINDINGS = 10;
/** Max lines of source per finding. */
const MAX_SOURCE_LINES = 25;

export interface JudgeAxes {
	correctness: number;
	groundedness: number;
	usefulness: number;
}

export interface JudgeResult {
	/** The label the judge saw. Variant ids never reach the judge. */
	label: string;
	/** Null when the call failed or the reply did not parse. */
	axes: JudgeAxes | null;
	/** 100 × (correctness + groundedness + usefulness) / 15, or null. */
	quality: number | null;
	rationale: string | null;
	error: string | null;
	attempts: number;
	model: string;
	thinking: string;
	/** sha256 of the prompt the judge was given. */
	promptSha256: string;
	/** How many findings the judge saw source lines for. */
	sourceFindings: number;
	promptTokens: number;
	outputTokens: number;
	costUsd: number;
	wallMs: number;
	/** Answer label → variant id. Kept here, never sent to the judge. */
	labelMap: Record<string, string>;
}

export interface JudgeOptions {
	task: LoadedTask;
	/** The answer as the parent sees it: truncated prose plus findings block. */
	answer: string;
	clones: Map<string, string>;
	/** Which variant produced the answer. Stripped before the judge sees it. */
	variantId: string;
	model: string;
	thinking: string;
	/** Directory for the raw judge stream. */
	outDir: string;
	/** File stem for the judge artifacts, e.g. `consola-options-type-v0-r1`. */
	cellId: string;
	timeoutMs?: number;
}

const AXIS_DEFINITIONS = [
	"correctness: does the answer answer the question with the facts the code actually contains? 5 = every expected fact is stated correctly; 3 = partly correct or missing a fact; 1 = wrong or evasive.",
	"groundedness: is every claim supported by the cited lines? 5 = each claim traces to a cited line that says it; 3 = some claims unsupported or cited lines do not show the claim; 1 = claims are unsupported or the citations are decorative.",
	"usefulness: would a developer act on this answer without re-reading the repository? 5 = direct, specific, complete; 3 = usable but padded; 1 = hedged, padded, or restates the question.",
].join("\n");

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Read a file from the first clone that holds it. */
function readCloneFile(
	clones: Map<string, string>,
	path: string,
): string[] | null {
	for (const [, clonePath] of clones) {
		const absolute = resolve(clonePath, path);
		if (
			absolute !== clonePath &&
			!absolute.startsWith(`${clonePath}${sep}`)
		) {
			continue;
		}
		try {
			if (!statSync(absolute).isFile()) continue;
			return readFileSync(absolute, "utf8").split("\n");
		} catch {
			continue;
		}
	}
	return null;
}

/** Cite the source around a finding so the judge can check the claim. */
function sourceExcerpt(
	clones: Map<string, string>,
	path: string,
	line: number | null,
): string | null {
	const lines = readCloneFile(clones, path);
	if (lines === null) return null;
	const center = line === null ? 1 : Math.min(line, lines.length);
	const from = Math.max(1, center - Math.floor(MAX_SOURCE_LINES / 2));
	const to = Math.min(lines.length, from + MAX_SOURCE_LINES - 1);
	const width = String(to).length;
	const body = lines
		.slice(from - 1, to)
		.map(
			(text, index) =>
				`${String(from + index).padStart(width)} | ${text}`,
		)
		.join("\n");
	return `${path}:${from}-${to}\n${body}`;
}

/** Build the judge prompt. No variant id, no run metadata, one answer. */
export function buildJudgePrompt(options: {
	task: LoadedTask;
	answer: string;
	clones: Map<string, string>;
	label: string;
}): { prompt: string; sourceFindings: number } {
	const { task, answer, clones, label } = options;
	const { findings } = parseFindingsBlock(answer);
	const checked = verifyFindings(findings, clones).slice(
		0,
		MAX_SOURCE_FINDINGS,
	);

	const factLines =
		task.expected.length === 0
			? [
					"(The correct answer is that the fact asked about does not exist.)",
				]
			: task.expected.map(
					(fact) =>
						`- \`${fact.path}:${fact.line}\` \`${fact.symbol}\` — ${fact.note}`,
				);

	const sourceBlocks: string[] = [];
	for (const finding of checked) {
		const excerpt = sourceExcerpt(clones, finding.path, finding.line);
		sourceBlocks.push(
			excerpt === null
				? `${finding.path}: the cited path does not exist in the repository. Claim: ${finding.claim}`
				: `Claim: ${finding.claim}\n${excerpt}`,
		);
	}
	if (sourceBlocks.length === 0) {
		sourceBlocks.push("(The answer cited no file.)");
	}

	const prompt = `You are grading one answer about a codebase. Judge only what is in front of you. Do not assume facts that the sources below do not show.

Question the answer was given:
${task.query}

The facts a correct answer must cover, with notes on what the code actually contains:
${factLines.join("\n")}

The files the answer cited, read from the repository at the pinned commit:
${sourceBlocks.join("\n\n")}

The answer, as the user receives it:
<answer ${label}>
${answer}
</answer ${label}>

Score three axes from 1 to 5:
${AXIS_DEFINITIONS}

Reply with one JSON object and nothing else, in this shape:
{"correctness":3,"groundedness":3,"usefulness":3,"rationale":"one sentence"}`;

	return { prompt, sourceFindings: checked.length };
}

interface JudgeRun {
	answer: string;
	promptTokens: number;
	outputTokens: number;
	costUsd: number;
	error: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function numberOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

/** Run the judge model once. No tools, no session, no extensions. */
async function runJudgeModel(options: {
	prompt: string;
	model: string;
	thinking: string;
	jsonlPath: string;
	cwd: string;
	timeoutMs: number;
}): Promise<JudgeRun> {
	const { prompt, model, thinking, jsonlPath, cwd, timeoutMs } = options;
	await mkdir(dirname(jsonlPath), { recursive: true });

	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--no-mcp",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--model",
		model,
		"--thinking",
		thinking,
		prompt,
	];

	const raw: string[] = [];
	const run: JudgeRun = {
		answer: "",
		promptTokens: 0,
		outputTokens: 0,
		costUsd: 0,
		error: null,
	};

	const exitCode = await new Promise<number | null>((resolve_) => {
		const child = spawn(process.env.PI_BIN ?? "pi", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
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
			resolve_(code);
		};

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			graceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
			run.error = `judge timed out after ${timeoutMs} ms`;
		}, timeoutMs);

		const handleLine = (line: string) => {
			if (line.trim().length === 0) return;
			raw.push(line);
			let event: Record<string, unknown> | undefined;
			try {
				event = asRecord(JSON.parse(line));
			} catch {
				return;
			}
			if (event === undefined || event.type !== "message_end") return;
			const message = asRecord(event.message);
			if (message?.role !== "assistant") return;
			const usage = asRecord(message.usage);
			run.promptTokens +=
				numberOf(usage?.input) +
				numberOf(usage?.cacheRead) +
				numberOf(usage?.cacheWrite);
			run.outputTokens += numberOf(usage?.output);
			run.costUsd += numberOf(asRecord(usage?.cost)?.total);
			const text = textOf(message.content);
			if (text.length > 0) run.answer = text;
			if (message.stopReason === "error") {
				run.error =
					typeof message.errorMessage === "string"
						? message.errorMessage
						: "judge provider error";
			}
		};

		child.stdout.on("data", (data: Buffer) => {
			buffer += decoder.write(data);
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString("utf8");
		});
		child.on("close", (code) => {
			buffer += decoder.end();
			if (buffer.trim().length > 0) handleLine(buffer);
			if (run.error === null && code !== 0) {
				const last = stderr
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line.length > 0)
					.at(-1);
				run.error = `judge exited with code ${code}${last === undefined ? "" : `: ${last.slice(0, 200)}`}`;
			}
			finish(code);
		});
		child.on("error", (error) => {
			run.error = `failed to spawn judge: ${error.message}`;
			finish(null);
		});
	});

	await writeFile(
		jsonlPath,
		raw.length > 0 ? `${raw.join("\n")}\n` : "",
		"utf-8",
	);
	if (run.error === null && exitCode === null) {
		run.error = "judge produced no output";
	}
	return run;
}

/** Parse the judge's reply. Strict: a partial object is a failed call. */
function parseJudgeReply(
	text: string,
): { axes: JudgeAxes; rationale: string } | string {
	const trimmed = text.trim();
	const candidates = [trimmed];
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) {
		candidates.push(trimmed.slice(start, end + 1));
	}

	for (const candidate of candidates) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		const record = asRecord(parsed);
		if (record === undefined) continue;
		const axis = (key: string): number | null => {
			const value = record[key];
			return typeof value === "number" &&
				Number.isInteger(value) &&
				value >= 1 &&
				value <= 5
				? value
				: null;
		};
		const correctness = axis("correctness");
		const groundedness = axis("groundedness");
		const usefulness = axis("usefulness");
		const rationale = record.rationale;
		if (
			correctness === null ||
			groundedness === null ||
			usefulness === null
		) {
			return `judge reply is missing a 1-5 axis: ${candidate.slice(0, 200)}`;
		}
		return {
			axes: { correctness, groundedness, usefulness },
			rationale:
				typeof rationale === "string"
					? rationale.trim().slice(0, 400)
					: "",
		};
	}
	return `judge reply is not JSON: ${trimmed.slice(0, 200)}`;
}

/**
 * Judge one cell. One answer per call, so no cell can contaminate another.
 *
 * A parse failure is retried once. When both attempts fail, the axes stay null
 * and `error` says why: the run records a missing judge score rather than
 * guessing one.
 */
export async function judgeCell(options: JudgeOptions): Promise<JudgeResult> {
	const {
		task,
		answer,
		clones,
		variantId,
		model,
		thinking,
		outDir,
		cellId,
		timeoutMs = RUN_TIMEOUT_MS,
	} = options;

	// One answer, one label. The mapping is stored beside the score; the judge
	// never sees a variant id.
	const label = "Answer A";
	const labelMap: Record<string, string> = { [label]: variantId };
	const built = buildJudgePrompt({ task, answer, clones, label });
	const promptSha = sha256(built.prompt);

	let attempts = 0;
	let error: string | null = null;
	let axes: JudgeAxes | null = null;
	let rationale: string | null = null;
	let promptTokens = 0;
	let outputTokens = 0;
	let costUsd = 0;
	const startedAt = Date.now();

	while (attempts < 2 && axes === null) {
		attempts++;
		const run = await runJudgeModel({
			prompt: built.prompt,
			model,
			thinking,
			jsonlPath: join(outDir, "judge", `${cellId}-a${attempts}.jsonl`),
			cwd: outDir,
			timeoutMs,
		});
		promptTokens += run.promptTokens;
		outputTokens += run.outputTokens;
		costUsd += run.costUsd;

		if (run.error !== null) {
			error = run.error;
			continue;
		}
		const parsed = parseJudgeReply(run.answer);
		if (typeof parsed === "string") {
			error = parsed;
			continue;
		}
		axes = parsed.axes;
		rationale = parsed.rationale;
		error = null;
	}

	return {
		label,
		axes,
		quality:
			axes === null
				? null
				: (100 *
						(axes.correctness +
							axes.groundedness +
							axes.usefulness)) /
					15,
		rationale,
		error,
		attempts,
		model,
		thinking,
		promptSha256: promptSha,
		sourceFindings: built.sourceFindings,
		promptTokens,
		outputTokens,
		costUsd,
		wallMs: Date.now() - startedAt,
		labelMap,
	};
}

export { DEFAULT_JUDGE_MODEL, DEFAULT_JUDGE_THINKING };
