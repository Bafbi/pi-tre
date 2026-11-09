import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { prepareRunClones, RUNS_DIR } from "./clones.ts";
import {
	DEFAULT_JUDGE_MODEL,
	DEFAULT_JUDGE_THINKING,
	DEFAULT_MODEL,
	DEFAULT_THINKING,
	ensureFloorTokens,
	type FloorKey,
	piVersion,
	type RunMetrics,
	runChild,
	toolListHash,
} from "./harness.ts";
import { type JudgeResult, judgeCell } from "./judge.ts";
import { getVariant } from "./prompt-variants.ts";
import { scoreAnswer, type TaskScore } from "./score.ts";
import { type LoadedTask, loadTasks, selectTasks } from "./tasks.ts";

/**
 * The benchmark driver: run every (variant, task, repeat) cell, score it twice
 * — deterministically and with an LLM judge — and write the report.
 *
 * Cells are interleaved by round: round 1 runs every (task, variant) pair, then
 * round 2, then round 3. Within a task the variant order is shuffled with a
 * recorded seed, so cache warming and provider drift do not line up with one
 * variant.
 *
 * Usage:
 *   node bench/run.ts --variants v0 --tasks all --repeat 3 --concurrency 3
 */

interface CellResult {
	variant: string;
	taskId: string;
	repeat: number;
	/** Recorded provenance, required in every results file. */
	promptSha256: string;
	piVersion: string;
	model: string;
	thinking: string;
	toolListHash: string;
	date: string;
	/** 0..100, or null when the cell failed. */
	deterministicQuality: number | null;
	judge: JudgeResult | null;
	judgeQuality: number | null;
	quality: number | null;
	/** |deterministic - judge|, or null when the judge did not answer. */
	disagreement: number | null;
	score: TaskScore | null;
	metrics: RunMetrics | null;
	promptTokens: number;
	promptTokensOurs: number;
	billedTokens: number;
	toolCalls: number;
	fabricatedPaths: string[];
	costUsd: number;
	judgeCostUsd: number;
	wallMs: number;
	error: string | null;
	jsonlPath: string;
}

interface Args {
	variants: string[];
	tasks: string;
	repeat: number;
	concurrency: number;
	model: string;
	thinking: string;
	judgeModel: string;
	judgeThinking: string;
	judge: boolean;
	seed: number;
	out: string | null;
	/** Rebuild report.md from an existing report.json. Costs nothing. */
	regenerate: string | null;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		variants: ["v0"],
		tasks: "all",
		repeat: 3,
		concurrency: 3,
		model: DEFAULT_MODEL,
		thinking: DEFAULT_THINKING,
		judgeModel: process.env.PI_BENCH_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
		judgeThinking: DEFAULT_JUDGE_THINKING,
		judge: true,
		seed: Math.floor(Math.random() * 2 ** 31),
		out: null,
		regenerate: null,
	};

	const value = (flag: string, raw: string | undefined): string => {
		if (raw === undefined) throw new Error(`${flag} needs a value`);
		return raw;
	};

	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const next = argv[i + 1];
		switch (flag) {
			case "--variants":
				args.variants = value(flag, next)
					.split(",")
					.map((id) => id.trim())
					.filter((id) => id.length > 0);
				i++;
				break;
			case "--tasks":
				args.tasks = value(flag, next);
				i++;
				break;
			case "--repeat":
				args.repeat = Number(value(flag, next));
				i++;
				break;
			case "--concurrency":
				args.concurrency = Number(value(flag, next));
				i++;
				break;
			case "--model":
				args.model = value(flag, next);
				i++;
				break;
			case "--thinking":
				args.thinking = value(flag, next);
				i++;
				break;
			case "--judge-model":
				args.judgeModel = value(flag, next);
				i++;
				break;
			case "--judge-thinking":
				args.judgeThinking = value(flag, next);
				i++;
				break;
			case "--no-judge":
				args.judge = false;
				break;
			case "--seed":
				args.seed = Number(value(flag, next));
				i++;
				break;
			case "--out":
				args.out = value(flag, next);
				i++;
				break;
			case "--regenerate":
				args.regenerate = value(flag, next);
				i++;
				break;
			default:
				throw new Error(`Unknown argument: ${flag}`);
		}
	}

	if (!Number.isInteger(args.repeat) || args.repeat < 1) {
		throw new Error("--repeat must be a positive integer");
	}
	if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
		throw new Error("--concurrency must be a positive integer");
	}
	if (!Number.isInteger(args.seed)) {
		throw new Error("--seed must be an integer");
	}
	for (const id of args.variants) getVariant(id);
	return args;
}

function stamp(): string {
	return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Deterministic PRNG, so a recorded seed reproduces the variant order. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffled<T>(items: T[], random: () => number): T[] {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		const a = copy[i];
		const b = copy[j];
		if (a !== undefined && b !== undefined) {
			copy[i] = b;
			copy[j] = a;
		}
	}
	return copy;
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
async function mapPool<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			for (;;) {
				const index = next++;
				if (index >= items.length) return;
				const item = items[index];
				if (item === undefined) return;
				results[index] = await fn(item, index);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

interface ScheduledCell {
	variantId: string;
	task: LoadedTask;
	repeat: number;
}

/**
 * Round-major schedule: every (task, variant) pair in round 1, then round 2.
 * Variant order within a task is shuffled per round.
 */
function schedule(
	variants: string[],
	tasks: LoadedTask[],
	repeat: number,
	seed: number,
): ScheduledCell[] {
	const random = mulberry32(seed);
	const cells: ScheduledCell[] = [];
	for (let round = 1; round <= repeat; round++) {
		for (const task of tasks) {
			for (const variantId of shuffled(variants, random)) {
				cells.push({ variantId, task, repeat: round });
			}
		}
	}
	return cells;
}

/**
 * Measure the floor for one task: the same run with a one-character appended
 * prompt. The difference is the provider-tokenized cost of our prompt.
 *
 * Runs after the cells, because the key includes the base prompt hash the cells
 * observed: a pi upgrade that keeps its version string still re-measures.
 */
async function measureFloor(
	task: LoadedTask,
	outDir: string,
	args: Args,
	basePromptHash: string,
): Promise<number> {
	const key: FloorKey = {
		repos: task.repos,
		query: task.query,
		model: args.model,
		thinking: args.thinking,
		piVersion: piVersion(),
		toolListHash: toolListHash(),
		basePromptHash,
	};
	const floorDir = await prepareRunClones(
		join(outDir, "clones", `_floor-${task.id}`),
		task.pinned,
	);
	const floor = await ensureFloorTokens(key, () =>
		runChild({
			systemPrompt: "x",
			query: task.query,
			cwd: floorDir.cwd,
			model: args.model,
			thinking: args.thinking,
			jsonlPath: join(outDir, "floor", `${task.id}.jsonl`),
		}),
	);
	await rm(floorDir.root, { recursive: true, force: true });
	return floor.tokens;
}

async function runCell(
	cell: ScheduledCell,
	outDir: string,
	args: Args,
): Promise<CellResult> {
	const { variantId, task, repeat } = cell;
	const variant = getVariant(variantId);
	const systemPrompt = variant.buildSystemPrompt(
		task.pinned.map((repo) => repo.parsed),
		task.query,
		task.pinned.length === 1,
	);
	const cellId = `${task.id}-${variantId}-r${repeat}`;
	const jsonlPath = join(outDir, "cells", variantId, `${cellId}.jsonl`);

	const base: CellResult = {
		variant: variantId,
		taskId: task.id,
		repeat,
		promptSha256: sha256(systemPrompt),
		piVersion: piVersion(),
		model: args.model,
		thinking: args.thinking,
		toolListHash: toolListHash(),
		date: new Date().toISOString(),
		deterministicQuality: null,
		judge: null,
		judgeQuality: null,
		quality: null,
		disagreement: null,
		score: null,
		metrics: null,
		promptTokens: 0,
		promptTokensOurs: 0,
		billedTokens: 0,
		toolCalls: 0,
		fabricatedPaths: [],
		costUsd: 0,
		judgeCostUsd: 0,
		wallMs: 0,
		error: null,
		jsonlPath,
	};

	try {
		const prepared = await prepareRunClones(
			join(outDir, "clones", cellId),
			task.pinned,
		);
		const metrics = await runChild({
			systemPrompt,
			query: task.query,
			cwd: prepared.cwd,
			model: args.model,
			thinking: args.thinking,
			jsonlPath,
		});
		const score = scoreAnswer(
			task,
			metrics.answer,
			prepared.clones,
			metrics.calls,
		);
		const deterministicQuality = 100 * score.score;

		// The judge sees the answer as the parent sees it: truncated, with the
		// findings block intact. A failed child run is not judged.
		let judge: JudgeResult | null = null;
		if (args.judge && metrics.error === null) {
			judge = await judgeCell({
				task,
				answer: metrics.answer,
				clones: prepared.clones,
				variantId,
				model: args.judgeModel,
				thinking: args.judgeThinking,
				outDir,
				cellId,
			});
		}
		const judgeQuality = judge?.quality ?? null;
		const quality =
			judgeQuality === null
				? deterministicQuality
				: 0.5 * deterministicQuality + 0.5 * judgeQuality;

		return {
			...base,
			deterministicQuality,
			judge,
			judgeQuality,
			quality,
			disagreement:
				judgeQuality === null
					? null
					: Math.abs(deterministicQuality - judgeQuality),
			score,
			metrics,
			promptTokens: metrics.promptTokens,
			billedTokens: metrics.billedTokens,
			toolCalls: metrics.toolCalls.total,
			fabricatedPaths: score.fabricatedPaths,
			costUsd: metrics.costUsd,
			judgeCostUsd: judge?.costUsd ?? 0,
			wallMs: metrics.wallMs,
			error: metrics.error,
		};
	} catch (error) {
		return {
			...base,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Print the per-cell table. */
function printTable(rows: string[][]): void {
	const widths = rows[0]?.map((_, column) =>
		Math.max(...rows.map((row) => (row[column] ?? "").length)),
	);
	for (const row of rows) {
		console.log(
			row
				.map((cell, column) => cell.padEnd(widths?.[column] ?? 0))
				.join("  ")
				.trimEnd(),
		);
	}
}

interface SummaryRow {
	variant: string;
	taskId: string;
	runs: number;
	deterministicQuality: number;
	judgeQuality: number | null;
	quality: number;
	disagreement: number | null;
	promptTokens: number;
	promptTokensOurs: number;
	billedTokens: number;
	toolCalls: number;
	fabricatedPaths: number;
	costUsd: number;
	wallMs: number;
	errors: string[];
	scores: TaskScore[];
	judgeRationales: string[];
}

function mean(values: number[]): number {
	return values.length === 0
		? 0
		: values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarise(cells: CellResult[]): SummaryRow[] {
	const groups = new Map<string, CellResult[]>();
	for (const cell of cells) {
		const key = `${cell.variant}\u0000${cell.taskId}`;
		const list = groups.get(key) ?? [];
		list.push(cell);
		groups.set(key, list);
	}

	return [...groups.entries()].map(([key, group]) => {
		const [variant, taskId] = key.split("\u0000");
		const measured = group.filter((cell) => cell.metrics !== null);
		const judged = group.filter(
			(cell) => cell.judgeQuality !== null,
		) as Array<CellResult & { judgeQuality: number }>;
		return {
			variant: variant ?? "",
			taskId: taskId ?? "",
			runs: group.length,
			deterministicQuality: mean(
				group.map((cell) => cell.deterministicQuality ?? 0),
			),
			judgeQuality:
				judged.length === 0
					? null
					: mean(judged.map((cell) => cell.judgeQuality)),
			quality: mean(group.map((cell) => cell.quality ?? 0)),
			disagreement:
				judged.length === 0
					? null
					: mean(judged.map((cell) => cell.disagreement ?? 0)),
			promptTokens: mean(
				measured.map((cell) => cell.metrics?.promptTokens ?? 0),
			),
			promptTokensOurs: mean(group.map((cell) => cell.promptTokensOurs)),
			billedTokens: mean(
				measured.map((cell) => cell.metrics?.billedTokens ?? 0),
			),
			toolCalls: mean(
				measured.map((cell) => cell.metrics?.toolCalls.total ?? 0),
			),
			fabricatedPaths: group.reduce(
				(sum, cell) => sum + cell.fabricatedPaths.length,
				0,
			),
			costUsd: group.reduce(
				(sum, cell) => sum + cell.costUsd + cell.judgeCostUsd,
				0,
			),
			wallMs: mean(measured.map((cell) => cell.metrics?.wallMs ?? 0)),
			errors: group
				.map((cell) => cell.error)
				.filter((error): error is string => error !== null),
			scores: group
				.map((cell) => cell.score)
				.filter((score): score is TaskScore => score !== null),
			judgeRationales: group
				.map((cell) => cell.judge?.rationale ?? null)
				.filter((value): value is string => value !== null),
		};
	});
}

/** Cells whose prompt tokens moved across repeats. A move is a real signal. */
function unstablePromptTokens(
	cells: CellResult[],
): Array<{ cell: string; values: number[] }> {
	const groups = new Map<string, number[]>();
	for (const cell of cells) {
		if (cell.metrics === null) continue;
		const key = `${cell.variant}/${cell.taskId}`;
		const list = groups.get(key) ?? [];
		list.push(cell.metrics.promptTokens);
		groups.set(key, list);
	}
	const unstable: Array<{ cell: string; values: number[] }> = [];
	for (const [cell, values] of groups) {
		if (values.length < 2) continue;
		if (Math.max(...values) - Math.min(...values) > 1) {
			unstable.push({ cell, values });
		}
	}
	return unstable;
}

/** Quality per 1000 tokens. Both numbers are printed; billedTokens decides. */
function per1k(quality: number, tokens: number): number {
	return tokens <= 0 ? 0 : quality / (tokens / 1000);
}

function reportMarkdown(
	summary: SummaryRow[],
	cells: CellResult[],
	args: Args,
	stampId: string,
	startedAt: string,
	unstable: Array<{ cell: string; values: number[] }>,
): string {
	const totalCost = cells.reduce(
		(sum, cell) => sum + cell.costUsd + cell.judgeCostUsd,
		0,
	);
	const childCost = cells.reduce((sum, cell) => sum + cell.costUsd, 0);
	const judgeCost = cells.reduce((sum, cell) => sum + cell.judgeCostUsd, 0);
	const judged = cells.filter((cell) => cell.judgeQuality !== null);
	const judgeFailures = cells.filter(
		(cell) => cell.judge !== null && cell.judge.axes === null,
	);

	const lines: string[] = [
		`# repo-query prompt benchmark — ${stampId}`,
		"",
		`- child model: \`${args.model}\` (thinking \`${args.thinking}\`)`,
		`- judge model: \`${args.judgeModel}\` (thinking \`${args.judgeThinking}\`)${args.judge ? "" : " — judge disabled"}`,
		`- pi: \`${piVersion()}\`, tool list hash \`${toolListHash().slice(0, 12)}\``,
		`- date: ${startedAt}`,
		`- variants: ${args.variants.join(", ")}`,
		`- tasks: ${new Set(summary.map((row) => row.taskId)).size}, repeat: ${args.repeat}, seed: ${args.seed}`,
		`- cost: \`$${totalCost.toFixed(4)}\` (child \`$${childCost.toFixed(4)}\`, judge \`$${judgeCost.toFixed(4)}\`)`,
		"",
		"## Baseline",
		"",
		"| task | det | judge | quality | disagree | promptTokensOurs | billedTokens | q/1k billed | q/1k promptOurs | toolCalls | fabricated | error |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|",
		...summary.map(
			(row) =>
				`| ${row.taskId} | ${row.deterministicQuality.toFixed(1)} | ${row.judgeQuality === null ? "—" : row.judgeQuality.toFixed(1)} | ${row.quality.toFixed(1)} | ${row.disagreement === null ? "—" : row.disagreement.toFixed(0)} | ${Math.round(row.promptTokensOurs)} | ${Math.round(row.billedTokens)} | ${per1k(row.quality, row.billedTokens).toFixed(1)} | ${per1k(row.quality, row.promptTokensOurs).toFixed(1)} | ${Math.round(row.toolCalls)} | ${row.fabricatedPaths} | ${row.errors[0] ?? ""} |`,
		),
		"",
		`**quality** = 0.5 × deterministic + 0.5 × judge. Deterministic: per fact, 0.25 path + 0.35 symbol + 0.40 line, minus 0.25 per fabricated path, floored at 0. A negative task needs an absence statement, no fabricated path, and 2 tool calls that searched for the term.`,
		"",
		`**efficiency**: \`quality / billedTokens\` decides, because prompt tokens are paid on every turn. \`quality / promptTokensOurs\` is the isolation number: the cost of our appended prompt alone, per 1k prompt tokens.`,
		"",
	];
	if (judged.length > 0) {
		const meanDet = mean(
			judged.map((cell) => cell.deterministicQuality ?? 0),
		);
		const meanJudge = mean(judged.map((cell) => cell.judgeQuality ?? 0));
		const meanGap = mean(judged.map((cell) => cell.disagreement ?? 0));
		lines.push(
			`- over ${judged.length} judged cell(s): mean deterministic ${meanDet.toFixed(1)}, mean judge ${meanJudge.toFixed(1)}, difference of means ${Math.abs(meanDet - meanJudge).toFixed(1)}, mean per-cell disagreement ${meanGap.toFixed(1)}`,
			"",
		);
	}
	if (judgeFailures.length > 0) {
		lines.push(
			`- judge failed on ${judgeFailures.length} cell(s): ${judgeFailures
				.map(
					(cell) =>
						`${cell.taskId}/r${cell.repeat}: ${cell.judge?.error ?? "unknown"}`,
				)
				.join("; ")}`,
			"",
		);
	}
	if (unstable.length > 0) {
		lines.push(
			"### Unstable prompt tokens",
			"",
			"Prompt tokens moved across repeats of the same cell. That is a real signal: the prompt, tool list, or provider tokenizer changed between runs.",
			"",
			...unstable.map(
				(entry) => `- \`${entry.cell}\`: ${entry.values.join(", ")}`,
			),
			"",
		);
	}

	lines.push("## Detail", "");
	for (const row of summary) {
		lines.push(`### ${row.taskId} (${row.variant})`, "");
		for (const score of row.scores) {
			lines.push(
				`- score ${score.score.toFixed(2)}: ${score.reason}; ${score.findingsCount} findings, ${score.answerWords} answer words, ${score.answerChars} chars`,
			);
			if (score.fabricatedPaths.length > 0) {
				lines.push(
					`  - fabricated paths: ${score.fabricatedPaths.join(", ")}`,
				);
			}
			for (const fact of score.facts) {
				lines.push(
					`  - \`${fact.path}:${fact.line}\` \`${fact.symbol}\`: path ${fact.pathHit ? "hit" : "miss"}, symbol ${fact.symbolHit ? "hit" : "miss"} (answer ${fact.symbolInAnswer ? "yes" : "no"}, tool args ${fact.symbolInArgs ? "yes" : "no"}), line ${fact.lineHit ? `hit at ${fact.citedLine}` : "miss"}${fact.primaryRange === null ? "" : ` [span ${fact.primaryRange[0]}-${fact.primaryRange[1]}]`} → ${fact.score.toFixed(2)}`,
				);
			}
			if (score.absenceSentence !== null) {
				lines.push(
					`  - absence check matched: "${score.absenceSentence}" (${score.evidenceCalls} evidence tool call(s))`,
				);
			}
		}
		for (const rationale of row.judgeRationales) {
			lines.push(`- judge: ${rationale}`);
		}
		const conflicts = cells.filter(
			(cell) =>
				cell.variant === row.variant &&
				cell.taskId === row.taskId &&
				cell.disagreement !== null &&
				cell.disagreement >= 25,
		);
		for (const conflict of conflicts) {
			lines.push(
				`- **disagreement ${conflict.disagreement?.toFixed(0)}** on repeat ${conflict.repeat}: deterministic ${conflict.deterministicQuality?.toFixed(1)}, judge ${conflict.judgeQuality?.toFixed(1)}. One of the two is wrong: check the ground truth or the rubric.`,
			);
		}
		lines.push("");
	}

	return `${lines.join("\n")}\n`;
}

/**
 * Rebuild `report.md` from an existing `report.json`.
 *
 * The markdown is a view of the recorded cells: a wording fix in the report
 * should not cost another run of the model.
 */
async function regenerateReport(target: string): Promise<number> {
	const named = join(RUNS_DIR, target);
	const outDir = existsSync(join(named, "report.json"))
		? named
		: resolve(target);
	const path = join(outDir, "report.json");
	if (!existsSync(path)) {
		throw new Error(`No report.json in ${outDir}`);
	}
	const stored = JSON.parse(await readFile(path, "utf-8")) as {
		stamp?: string;
		date?: string;
		model?: string;
		thinking?: string;
		judgeModel?: string | null;
		judgeThinking?: string | null;
		variants?: string[];
		repeat?: number;
		seed?: number;
		cells: CellResult[];
	};
	const cells = stored.cells;
	const args: Args = {
		variants: stored.variants ?? ["v0"],
		tasks: "all",
		repeat: stored.repeat ?? 1,
		concurrency: 1,
		model: stored.model ?? "unknown",
		thinking: stored.thinking ?? "unknown",
		judgeModel: stored.judgeModel ?? "none",
		judgeThinking: stored.judgeThinking ?? "none",
		judge: stored.judgeModel !== null && stored.judgeModel !== undefined,
		seed: stored.seed ?? 0,
		out: null,
		regenerate: target,
	};
	await writeFile(
		join(outDir, "report.md"),
		reportMarkdown(
			summarise(cells),
			cells,
			args,
			stored.stamp ?? target,
			stored.date ?? "",
			unstablePromptTokens(cells),
		),
		"utf-8",
	);
	console.log(`rewrote ${join(outDir, "report.md")}`);
	return 0;
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (args.regenerate !== null) return regenerateReport(args.regenerate);
	const allTasks = loadTasks();
	const tasks = selectTasks(allTasks, args.tasks);
	const stampId = stamp();
	const startedAt = new Date().toISOString();
	const outDir = join(RUNS_DIR, args.out ?? stampId);
	await mkdir(outDir, { recursive: true });

	console.log(
		`repo-query prompt benchmark: ${tasks.length} task(s) × ${args.variants.length} variant(s) × ${args.repeat} repeat(s)`,
	);
	console.log(`child ${args.model} (thinking ${args.thinking})`);
	console.log(
		`judge ${args.judge ? `${args.judgeModel} (thinking ${args.judgeThinking})` : "disabled"}`,
	);
	console.log(`seed ${args.seed}`);
	console.log(`writing to ${outDir}`);

	const work = schedule(args.variants, tasks, args.repeat, args.seed);
	const cells = await mapPool(work, args.concurrency, async (item) => {
		const result = await runCell(item, outDir, args);
		const state = result.error === null ? "ok  " : "FAIL";
		const judge =
			result.judgeQuality === null
				? "  —  "
				: result.judgeQuality.toFixed(1);
		console.log(
			`  ${state} ${result.variant} ${result.taskId} r${result.repeat}: det ${(result.deterministicQuality ?? 0).toFixed(1)} judge ${judge} quality ${(result.quality ?? 0).toFixed(1)}${result.error === null ? "" : ` (${result.error})`}`,
		);
		return result;
	});

	// Floors run after the cells so the key can carry the base prompt hash the
	// cells actually saw. This is what makes a pi upgrade re-measure.
	const floors = new Map<string, number>();
	await mapPool(tasks, args.concurrency, async (task) => {
		const basePromptHash =
			cells.find(
				(cell) =>
					cell.taskId === task.id &&
					cell.metrics !== null &&
					cell.metrics.basePromptHash !== "",
			)?.metrics?.basePromptHash ?? "";
		const tokens = await measureFloor(task, outDir, args, basePromptHash);
		floors.set(task.id, tokens);
		console.log(`  floor ${task.id}: ${tokens} prompt tokens`);
	});
	for (const cell of cells) {
		if (cell.metrics === null) continue;
		cell.promptTokensOurs =
			cell.metrics.promptTokens - (floors.get(cell.taskId) ?? 0);
	}

	const summary = summarise(cells);
	const rows: string[][] = [
		[
			"task",
			"det",
			"judge",
			"quality",
			"disagree",
			"promptTokensOurs",
			"billedTokens",
			"q/1k billed",
			"q/1k promptOurs",
			"toolCalls",
			"fabricated",
			"error",
		],
		...summary.map((row) => [
			row.taskId,
			row.deterministicQuality.toFixed(1),
			row.judgeQuality === null ? "—" : row.judgeQuality.toFixed(1),
			row.quality.toFixed(1),
			row.disagreement === null ? "—" : row.disagreement.toFixed(0),
			String(Math.round(row.promptTokensOurs)),
			String(Math.round(row.billedTokens)),
			per1k(row.quality, row.billedTokens).toFixed(1),
			per1k(row.quality, row.promptTokensOurs).toFixed(1),
			String(Math.round(row.toolCalls)),
			String(row.fabricatedPaths),
			row.errors[0] ?? "",
		]),
	];

	console.log("");
	printTable(rows);

	const unstable = unstablePromptTokens(cells);
	for (const entry of unstable) {
		console.warn(
			`warning: promptTokens moved for ${entry.cell}: ${entry.values.join(", ")}`,
		);
	}

	const totalCost = cells.reduce(
		(sum, cell) => sum + cell.costUsd + cell.judgeCostUsd,
		0,
	);
	const judgeCost = cells.reduce((sum, cell) => sum + cell.judgeCostUsd, 0);
	console.log("");
	console.log(
		`cost: $${totalCost.toFixed(4)} (child $${(totalCost - judgeCost).toFixed(4)}, judge $${judgeCost.toFixed(4)})`,
	);

	await writeFile(
		join(outDir, "report.json"),
		`${JSON.stringify(
			{
				stamp: stampId,
				date: startedAt,
				piVersion: piVersion(),
				model: args.model,
				thinking: args.thinking,
				judgeModel: args.judge ? args.judgeModel : null,
				judgeThinking: args.judge ? args.judgeThinking : null,
				toolListHash: toolListHash(),
				variants: args.variants,
				repeat: args.repeat,
				seed: args.seed,
				floors: Object.fromEntries(floors),
				totalCostUsd: totalCost,
				judgeCostUsd: judgeCost,
				summary,
				cells,
			},
			null,
			"\t",
		)}\n`,
		"utf-8",
	);
	await writeFile(
		join(outDir, "report.md"),
		reportMarkdown(summary, cells, args, stampId, startedAt, unstable),
		"utf-8",
	);

	console.log(`\nreport: ${join(outDir, "report.md")}`);

	const failed = cells.filter((cell) => cell.error !== null);
	if (failed.length > 0) {
		console.error(
			`${failed.length} cell(s) failed: ${failed.map((cell) => `${cell.taskId}/${cell.variant}/r${cell.repeat}`).join(", ")}`,
		);
		return 1;
	}
	return 0;
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	},
);
