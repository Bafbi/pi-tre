import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { RUNS_DIR } from "./clones.ts";

/**
 * Paired comparison of two runs: candidate minus baseline, task by task.
 *
 * Usage:
 *   node bench/compare.ts <baselineRunDir> <candidateRunDir> [--variant id]
 *                         [--allow-prompt-change]
 *
 * A run directory is a path, or a name under `bench/runs/`.
 *
 * Two runs are only comparable when they measure the same thing: same child
 * model, thinking level, pi version, tool list, and the same prompt bytes for
 * the variant being compared. The guard refuses anything else and prints what
 * differs, because a delta across a pi upgrade is not a prompt delta.
 */

/** Two runs are the same setting within this many points on the 0-100 scale. */
const QUALITY_EPSILON = 0.5;

interface Cell {
	variant: string;
	taskId: string;
	repeat: number;
	promptSha256?: string;
	piVersion?: string;
	model?: string;
	thinking?: string;
	toolListHash?: string;
	deterministicQuality: number | null;
	judgeQuality: number | null;
	quality: number | null;
	disagreement: number | null;
	promptTokensOurs: number;
	billedTokens: number;
	error: string | null;
}

/**
 * Provenance fields are optional because a run written before they existed is
 * still readable: it just cannot be compared, and the guard says so.
 */
interface Report {
	stamp: string;
	date?: string;
	piVersion?: string;
	model?: string;
	thinking?: string;
	judgeModel?: string | null;
	judgeThinking?: string | null;
	toolListHash?: string;
	variants: string[];
	repeat?: number;
	seed?: number;
	cells: Cell[];
}

function loadReport(runDir: string): Report {
	const path = join(runDir, "report.json");
	if (!existsSync(path)) {
		throw new Error(`No report.json in ${runDir}`);
	}
	return JSON.parse(readFileSync(path, "utf-8")) as Report;
}

/** Resolve a run directory: a path, or a name under `bench/runs/`. */
function resolveRunDir(value: string): string {
	const direct = resolve(value);
	if (existsSync(join(direct, "report.json"))) return direct;
	const named = join(RUNS_DIR, value);
	if (existsSync(join(named, "report.json"))) return named;
	throw new Error(
		`No run directory at ${direct} or ${named} (expected a report.json)`,
	);
}

function parseArgs(argv: string[]): {
	baseline: string;
	candidate: string;
	variant: string | null;
	allowPromptChange: boolean;
} {
	let baseline: string | null = null;
	let candidate: string | null = null;
	let variant: string | null = null;
	let allowPromptChange = false;

	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--variant") {
			const value = argv[i + 1];
			if (value === undefined) throw new Error("--variant needs a value");
			variant = value;
			i++;
			continue;
		}
		if (flag === "--allow-prompt-change") {
			allowPromptChange = true;
			continue;
		}
		if (flag?.startsWith("--")) {
			throw new Error(`Unknown argument: ${flag}`);
		}
		if (baseline === null) baseline = flag ?? null;
		else if (candidate === null) candidate = flag ?? null;
		else throw new Error(`Unexpected argument: ${flag}`);
	}

	if (baseline === null || candidate === null) {
		throw new Error(
			"usage: node bench/compare.ts <baselineRunDir> <candidateRunDir> [--variant id] [--allow-prompt-change]",
		);
	}
	return { baseline, candidate, variant, allowPromptChange };
}

function mean(values: number[]): number;
function mean(values: number[]): number | null;
function mean(values: number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Two-sided exact binomial test over wins and losses. */
function signTest(wins: number, losses: number): number {
	const n = wins + losses;
	if (n === 0) return 1;
	const logFactorial = (k: number): number => {
		let sum = 0;
		for (let i = 2; i <= k; i++) sum += Math.log(i);
		return sum;
	};
	const logChoose = (a: number, b: number): number =>
		logFactorial(a) - logFactorial(b) - logFactorial(a - b);
	let tail = 0;
	for (let k = 0; k <= Math.min(wins, losses); k++) {
		tail += Math.exp(logChoose(n, k) - n * Math.log(2));
	}
	return Math.min(1, 2 * tail);
}

interface TaskComparison {
	taskId: string;
	baselineQuality: number | null;
	candidateQuality: number | null;
	deltaQuality: number | null;
	deltaDeterministic: number | null;
	deltaJudge: number | null;
	deltaPromptTokensOurs: number | null;
	deltaBilledTokens: number | null;
	outcome: "win" | "loss" | "tie" | "missing";
}

function compareTask(
	baselineCells: Cell[],
	candidateCells: Cell[],
	taskId: string,
): TaskComparison {
	const baselineQuality = mean(
		baselineCells
			.map((cell) => cell.quality)
			.filter((value): value is number => value !== null),
	);
	const candidateQuality = mean(
		candidateCells
			.map((cell) => cell.quality)
			.filter((value): value is number => value !== null),
	);

	if (baselineQuality === null || candidateQuality === null) {
		return {
			taskId,
			baselineQuality,
			candidateQuality,
			deltaQuality: null,
			deltaDeterministic: null,
			deltaJudge: null,
			deltaPromptTokensOurs: null,
			deltaBilledTokens: null,
			outcome: "missing",
		};
	}

	const deltaQuality = candidateQuality - baselineQuality;
	const outcome: TaskComparison["outcome"] =
		deltaQuality > QUALITY_EPSILON
			? "win"
			: deltaQuality < -QUALITY_EPSILON
				? "loss"
				: "tie";

	const deterministicDelta = (): number | null => {
		const base = mean(
			baselineCells
				.map((cell) => cell.deterministicQuality)
				.filter((value): value is number => value !== null),
		);
		const cand = mean(
			candidateCells
				.map((cell) => cell.deterministicQuality)
				.filter((value): value is number => value !== null),
		);
		return base === null || cand === null ? null : cand - base;
	};
	const judgeDelta = (): number | null => {
		const base = mean(
			baselineCells
				.map((cell) => cell.judgeQuality)
				.filter((value): value is number => value !== null),
		);
		const cand = mean(
			candidateCells
				.map((cell) => cell.judgeQuality)
				.filter((value): value is number => value !== null),
		);
		return base === null || cand === null ? null : cand - base;
	};

	const promptOurs = mean(
		candidateCells.map((cell) => cell.promptTokensOurs),
	);
	const promptOursBase = mean(
		baselineCells.map((cell) => cell.promptTokensOurs),
	);
	const billed = mean(candidateCells.map((cell) => cell.billedTokens));
	const billedBase = mean(baselineCells.map((cell) => cell.billedTokens));

	return {
		taskId,
		baselineQuality,
		candidateQuality,
		deltaQuality,
		deltaDeterministic: deterministicDelta(),
		deltaJudge: judgeDelta(),
		deltaPromptTokensOurs:
			promptOurs === null || promptOursBase === null
				? null
				: promptOurs - promptOursBase,
		deltaBilledTokens:
			billed === null || billedBase === null ? null : billed - billedBase,
		outcome,
	};
}

function pickVariant(
	baseline: Report,
	candidate: Report,
	requested: string | null,
): string {
	if (requested !== null) {
		if (!baseline.variants.includes(requested)) {
			throw new Error(
				`Baseline ${baseline.stamp} has no variant "${requested}" (has: ${baseline.variants.join(", ")})`,
			);
		}
		if (!candidate.variants.includes(requested)) {
			throw new Error(
				`Candidate ${candidate.stamp} has no variant "${requested}" (has: ${candidate.variants.join(", ")})`,
			);
		}
		return requested;
	}
	if (baseline.variants.length !== 1 || candidate.variants.length !== 1) {
		throw new Error(
			`Both runs must measure one variant, or pass --variant. Baseline: ${baseline.variants.join(", ")}; candidate: ${candidate.variants.join(", ")}`,
		);
	}
	const [only] = baseline.variants;
	if (only === undefined) throw new Error("Baseline records no variant");
	if (!candidate.variants.includes(only)) {
		throw new Error(
			`Baseline measures "${only}", candidate measures ${candidate.variants.join(", ")}. Pass --variant with an id both runs share.`,
		);
	}
	return only;
}

function fmt(value: number | null, digits = 1): string {
	return value === null ? "—" : value.toFixed(digits);
}

function main(): number {
	const args = parseArgs(process.argv.slice(2));
	const baselineDir = resolveRunDir(args.baseline);
	const candidateDir = resolveRunDir(args.candidate);
	const baseline = loadReport(baselineDir);
	const candidate = loadReport(candidateDir);

	console.log(
		`baseline:  ${baselineDir} (${baseline.stamp}, ${baseline.date})`,
	);
	console.log(
		`candidate: ${candidateDir} (${candidate.stamp}, ${candidate.date})`,
	);

	const differences: string[] = [];
	const compareField = (
		label: string,
		base: string | null | undefined,
		cand: string | null | undefined,
	): void => {
		const shown = (value: string | null | undefined): string =>
			value === undefined || value === null || value === ""
				? "not recorded"
				: value;
		if (shown(base) !== shown(cand)) {
			differences.push(
				`${label}: baseline ${shown(base)}, candidate ${shown(cand)}`,
			);
		}
	};
	compareField("child model", baseline.model, candidate.model);
	compareField("thinking", baseline.thinking, candidate.thinking);
	compareField("pi version", baseline.piVersion, candidate.piVersion);
	compareField(
		"tool list hash",
		baseline.toolListHash,
		candidate.toolListHash,
	);
	if (baseline.judgeModel !== candidate.judgeModel) {
		console.warn(
			`warning: judge model differs (baseline ${baseline.judgeModel ?? "—"}, candidate ${candidate.judgeModel ?? "—"}): the combined quality scale is not identical`,
		);
	}

	const variant = pickVariant(baseline, candidate, args.variant);
	const shasOf = (report: Report, id: string): Set<string> =>
		new Set(
			report.cells
				.filter((cell) => cell.variant === id)
				.map((cell) => cell.promptSha256)
				.filter((sha): sha is string => typeof sha === "string"),
		);
	const baselineSha = shasOf(baseline, variant);
	const candidateSha = shasOf(candidate, variant);

	if (baselineSha.size === 0 || candidateSha.size === 0) {
		differences.push(
			`prompt sha256: baseline ${baselineSha.size === 0 ? "not recorded" : `${baselineSha.size} value(s)`}, candidate ${candidateSha.size === 0 ? "not recorded" : `${candidateSha.size} value(s)`}`,
		);
	}
	const promptChanged =
		baselineSha.size > 0 &&
		candidateSha.size > 0 &&
		[...baselineSha].some((sha) => !candidateSha.has(sha));

	if (promptChanged) {
		const base = [...baselineSha].map((sha) => sha.slice(0, 12)).join(", ");
		const cand = [...candidateSha]
			.map((sha) => sha.slice(0, 12))
			.join(", ");
		if (!args.allowPromptChange) {
			differences.push(
				`prompt sha256: baseline ${base}, candidate ${cand}`,
			);
		} else {
			console.log(
				`note: prompt sha256 differs (baseline ${base}, candidate ${cand}); comparing anyway because --allow-prompt-change was passed`,
			);
		}
	}

	if (differences.length > 0) {
		console.error("");
		console.error(
			"The runs are not comparable. Nothing was computed. What differs:",
		);
		for (const difference of differences)
			console.error(`  - ${difference}`);
		console.error("");
		console.error(
			"A different prompt is the one expected difference: pass --allow-prompt-change to compare across it.",
		);
		return 1;
	}

	const tasks = [
		...new Set(
			baseline.cells
				.filter((cell) => cell.variant === variant)
				.map((cell) => cell.taskId),
		),
	].filter((taskId) =>
		candidate.cells.some(
			(cell) => cell.variant === variant && cell.taskId === taskId,
		),
	);

	if (tasks.length === 0) {
		console.error(`No shared tasks for variant "${variant}"`);
		return 1;
	}

	const comparisons = tasks.map((taskId) =>
		compareTask(
			baseline.cells.filter(
				(cell) => cell.variant === variant && cell.taskId === taskId,
			),
			candidate.cells.filter(
				(cell) => cell.variant === variant && cell.taskId === taskId,
			),
			taskId,
		),
	);

	const rows: string[][] = [
		[
			"task",
			"baseline",
			"candidate",
			"Δquality",
			"Δdet",
			"Δjudge",
			"ΔpromptOurs",
			"Δbilled",
			"outcome",
		],
		...comparisons.map((row) => [
			row.taskId,
			fmt(row.baselineQuality),
			fmt(row.candidateQuality),
			fmt(row.deltaQuality),
			fmt(row.deltaDeterministic),
			fmt(row.deltaJudge),
			fmt(row.deltaPromptTokensOurs, 0),
			fmt(row.deltaBilledTokens, 0),
			row.outcome,
		]),
	];
	const widths = rows[0]?.map((_, column) =>
		Math.max(...rows.map((row) => (row[column] ?? "").length)),
	);
	console.log("");
	for (const row of rows) {
		console.log(
			row
				.map((cell, column) => cell.padEnd(widths?.[column] ?? 0))
				.join("  ")
				.trimEnd(),
		);
	}

	const wins = comparisons.filter((row) => row.outcome === "win").length;
	const losses = comparisons.filter((row) => row.outcome === "loss").length;
	const ties = comparisons.filter((row) => row.outcome === "tie").length;
	const missing = comparisons.filter(
		(row) => row.outcome === "missing",
	).length;
	const p = signTest(wins, losses);

	const baselineBilled = mean(
		baseline.cells
			.filter((cell) => cell.variant === variant)
			.map((cell) => cell.billedTokens),
	);
	const candidateBilled = mean(
		candidate.cells
			.filter((cell) => cell.variant === variant)
			.map((cell) => cell.billedTokens),
	);
	const billedDelta =
		baselineBilled === null || candidateBilled === null
			? null
			: candidateBilled - baselineBilled;

	let verdict: string;
	if (wins >= 5 && losses <= 1) {
		verdict = "candidate better";
	} else if (losses >= 5 && wins <= 1) {
		verdict = "candidate worse";
	} else if (wins === 0 && losses === 0 && ties > 0) {
		verdict =
			billedDelta !== null && billedDelta < 0
				? `tie on quality, candidate cheaper by ${Math.abs(Math.round(billedDelta))} billed tokens → win`
				: "tie on quality, no token win";
	} else {
		verdict = "inconclusive";
	}

	console.log("");
	console.log(
		`variant: ${variant}, ${comparisons.length} shared task(s) (missing: ${missing})`,
	);
	console.log(
		`wins ${wins}, losses ${losses}, ties ${ties}; sign test p = ${p.toFixed(3)} (two-sided, ties excluded)`,
	);
	console.log(
		`billed tokens: baseline ${baselineBilled === null ? "—" : Math.round(baselineBilled)}, candidate ${candidateBilled === null ? "—" : Math.round(candidateBilled)}, delta ${billedDelta === null ? "—" : Math.round(billedDelta)}`,
	);
	console.log("");
	console.log("verdict rules:");
	console.log(
		`  - better: at least 5 wins and at most 1 loss over the shared tasks (a tie is within ${QUALITY_EPSILON} points of quality)`,
	);
	console.log("  - tie on quality with a lower billed-token count is a win");
	console.log(`verdict: ${verdict}`);

	return 0;
}

try {
	process.exit(main());
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
