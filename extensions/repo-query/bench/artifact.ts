import { readFileSync } from "node:fs";
import { join } from "node:path";

interface JudgeAxes {
	correctness: number;
	groundedness: number;
	usefulness: number;
}

interface Metrics {
	turns: number;
	toolCalls: { total: number; byName: Record<string, number> };
	toolResultChars: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	billedTokens: number;
	promptTokens: number;
	answerChars: number;
}

interface Cell {
	variant: string;
	taskId: string;
	repeat: number;
	deterministicQuality: number;
	judgeQuality: number;
	quality: number;
	disagreement: number;
	judge?: { axes?: JudgeAxes; rationale?: string };
	metrics: Metrics;
}

interface Summary {
	variant: string;
	taskId: string;
	runs: number;
	deterministicQuality: number;
	judgeQuality: number;
	quality: number;
	disagreement: number;
	promptTokens: number;
	promptTokensOurs: number;
	billedTokens: number;
	toolCalls: number;
	fabricatedPaths: number;
	costUsd: number;
	wallMs: number;
	errors: string[];
}

interface Report {
	stamp: string;
	date: string;
	piVersion: string;
	model: string;
	thinking: string;
	judgeModel: string;
	judgeThinking: string;
	repeat: number;
	seed: number;
	totalCostUsd: number;
	judgeCostUsd: number;
	summary: Summary[];
	cells: Cell[];
}

interface TurnCall {
	tool: string;
	args: string;
	chars: number;
	isError: boolean;
}

interface Turn {
	index: number;
	calls: TurnCall[];
	inTok: number;
	outTok: number;
}

const esc = (v: unknown): string =>
	String(v)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

const mean = (xs: number[]): number =>
	xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

const num = (n: number, digits = 1): string => n.toFixed(digits);

const runDir = process.argv[2];
if (!runDir) {
	process.stderr.write(
		"usage: node bench/artifact.ts <runDir> [traceTask]\n",
	);
	process.exit(2);
}

const report = JSON.parse(
	readFileSync(join(runDir, "report.json"), "utf-8"),
) as Report;
const rows = report.summary;
const cells = report.cells;
const first = rows[0];

const detMean = mean(rows.map((r) => r.deterministicQuality));
const judgeMean = mean(rows.map((r) => r.judgeQuality));
const qualMean = mean(rows.map((r) => r.quality));
const disMean = mean(rows.map((r) => r.disagreement));
const promptOurs = mean(rows.map((r) => r.promptTokensOurs));
const billed = mean(rows.map((r) => r.billedTokens));
const callsMean = mean(rows.map((r) => r.toolCalls));
const turnsMean = mean(cells.map((c) => c.metrics.turns));
const outMean = mean(cells.map((c) => c.metrics.outputTokens));
const inMean = mean(cells.map((c) => c.metrics.inputTokens));
const cacheMean = mean(cells.map((c) => c.metrics.cacheReadTokens));
const resCharsMean = mean(cells.map((c) => c.metrics.toolResultChars));
const costMean = mean(rows.map((r) => r.costUsd));
const promptShare = (promptOurs * turnsMean * 100) / billed;
const billedK = billed / 1000;

interface Section {
	name: string;
	chars: number;
	tok: number;
	note: string;
	flag: string;
}

const notes: Record<string, [string, string]> = {
	"Role and location": ["Sets the role and the repository name.", ""],
	"Process, 4 steps": [
		"find/ls, grep, read with offset, do not read big files.",
		"generic tool advice",
	],
	"Output requirements": [
		"Paths and lines, say when not found, 800 words, no assumptions.",
		"",
	],
	"Findings block": [
		"The machine-readable contract the tool verifies.",
		"load-bearing",
	],
	"Query echo": [
		"The same query the task message already carries.",
		"duplicate",
	],
};

let sections: Section[] = [];
const promptName =
	first === undefined ? "" : first.taskId + "-v0-r1.jsonl.prompt.txt";
try {
	const text = readFileSync(join(runDir, "cells", "v0", promptName), "utf-8");
	const marks: Array<[string, string, string]> = [
		["Role and location", "", "Process:"],
		["Process, 4 steps", "Process:", "Output requirements:"],
		[
			"Output requirements",
			"Output requirements:",
			"End the answer with one fenced",
		],
		["Findings block", "End the answer with one fenced", "Query: "],
	];
	const parts: Array<[string, number]> = [];
	for (const [name, from, to] of marks) {
		const start = from === "" ? 0 : text.indexOf(from);
		const end = text.indexOf(to, start);
		if (start < 0 || end < 0) continue;
		parts.push([name, end - start]);
	}
	const qIdx = text.indexOf("Query: ");
	if (qIdx >= 0) parts.push(["Query echo", text.length - qIdx]);
	const total = text.length;
	sections = parts.map(([name, chars]) => ({
		name,
		chars,
		tok: (chars / total) * promptOurs,
		note: notes[name]?.[0] ?? "",
		flag: notes[name]?.[1] ?? "",
	}));
} catch {
	sections = [];
}

const traceTask = process.argv[3] ?? first?.taskId ?? "";
let turns: Turn[] = [];
let answer = "";
try {
	const lines = readFileSync(
		join(runDir, "cells", "v0", traceTask + "-v0-r1.jsonl"),
		"utf-8",
	).split("\n");
	const pending = new Map<string, { tool: string; args: string }>();
	let current: Turn | null = null;
	let n = 0;
	for (const line of lines) {
		if (!line.trim()) continue;
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (e.type === "turn_start") {
			n += 1;
			current = { index: n, calls: [], inTok: 0, outTok: 0 };
			turns.push(current);
		}
		if (current === null) continue;
		if (e.type === "tool_execution_start") {
			const args = (e.args ?? {}) as Record<string, unknown>;
			const firstArg = Object.values(args)[0];
			pending.set(String(e.toolCallId), {
				tool: String(e.toolName),
				args:
					typeof firstArg === "string"
						? firstArg
						: JSON.stringify(args),
			});
		}
		if (e.type === "tool_execution_end") {
			const p = pending.get(String(e.toolCallId));
			const result = (e.result ?? {}) as {
				content?: Array<{ text?: string }>;
			};
			const chars = (result.content ?? []).reduce(
				(a, b) => a + (b.text?.length ?? 0),
				0,
			);
			if (p !== undefined) {
				current.calls.push({
					...p,
					chars,
					isError: e.isError === true,
				});
			}
		}
		if (e.type === "message_end") {
			const m = (e.message ?? {}) as {
				role?: string;
				usage?: { input?: number; output?: number };
				content?: Array<{ type: string; text?: string }>;
			};
			if (m.role === "assistant") {
				current.inTok = m.usage?.input ?? 0;
				current.outTok = m.usage?.output ?? 0;
				const text = (m.content ?? [])
					.filter((b) => b.type === "text")
					.map((b) => b.text ?? "")
					.join("");
				if (text.length > answer.length) answer = text;
			}
		}
	}
} catch {
	turns = [];
}

const billeds = rows.map((r) => r.billedTokens);
const maxBilled = Math.max(...billeds, 1);
const minBilled = Math.min(...billeds);
const quals = rows.map((r) => r.quality);
const qMin = Math.min(...quals);
const qMax = Math.max(...quals);
const sectionTotal = sections.reduce((a, b) => a + b.chars, 0);

const scatter = rows
	.map((r) => {
		const x =
			6 +
			((r.billedTokens - minBilled) /
				Math.max(maxBilled - minBilled, 1)) *
				88;
		const y = 6 + ((qMax - r.quality) / Math.max(qMax - qMin, 1)) * 78;
		const label =
			r.taskId.length > 22 ? r.taskId.slice(0, 20) + "…" : r.taskId;
		return (
			'<div class="dot" style="left:' +
			x.toFixed(1) +
			"%;top:" +
			y.toFixed(1) +
			'%"><span class="dotv">' +
			r.quality.toFixed(0) +
			'</span><span class="dotl">' +
			esc(label) +
			"</span></div>"
		);
	})
	.join("");

const sectionBars = sections
	.map((s, i) => {
		const pct = sectionTotal === 0 ? 0 : (s.chars / sectionTotal) * 100;
		return (
			'<div class="seg s' +
			(i % 5) +
			'" style="width:' +
			pct.toFixed(1) +
			'%"></div>'
		);
	})
	.join("");

const sectionRows = sections
	.map((s, i) => {
		let tag = "";
		if (s.flag === "duplicate")
			tag = '<span class="tag bad">duplicate</span>';
		else if (s.flag === "load-bearing")
			tag = '<span class="tag good">load-bearing</span>';
		else if (s.flag === "generic tool advice")
			tag = '<span class="tag warn">generic</span>';
		return (
			'<tr><td><span class="sw s' +
			(i % 5) +
			'"></span>' +
			esc(s.name) +
			" " +
			tag +
			'</td><td class="n">' +
			s.chars +
			'</td><td class="n">~' +
			s.tok.toFixed(0) +
			'</td><td class="muted">' +
			esc(s.note) +
			"</td></tr>"
		);
	})
	.join("");

const taskRows = rows
	.map((r) => {
		const err =
			r.errors.length > 0 ? '<span class="tag bad">error</span>' : "";
		const eff = r.quality / (r.billedTokens / 1000);
		return (
			'<tr><td class="mono">' +
			esc(r.taskId) +
			" " +
			err +
			'</td><td class="n">' +
			num(r.deterministicQuality) +
			'</td><td class="n">' +
			num(r.judgeQuality) +
			'</td><td class="n strong">' +
			num(r.quality) +
			'</td><td class="n ' +
			(r.disagreement > 15 ? "warnc" : "muted") +
			'">' +
			r.disagreement.toFixed(0) +
			'</td><td class="n">' +
			r.promptTokensOurs.toFixed(0) +
			'</td><td class="n">' +
			(r.billedTokens / 1000).toFixed(1) +
			'k</td><td class="n">' +
			eff.toFixed(2) +
			'</td><td class="n">' +
			r.toolCalls.toFixed(0) +
			"</td></tr>"
		);
	})
	.join("");

const turnRows = turns
	.map((t) => {
		const calls = t.calls
			.map((c) => {
				const short =
					c.args.length > 62 ? c.args.slice(0, 60) + "…" : c.args;
				const big =
					c.chars > 5000 ? ' class="call big"' : ' class="call"';
				return (
					"<div" +
					big +
					'><span class="tool">' +
					esc(c.tool) +
					'</span> <span class="args">' +
					esc(short) +
					'</span> <span class="chars">' +
					c.chars.toLocaleString() +
					" ch</span></div>"
				);
			})
			.join("");
		return (
			'<tr><td class="n">' +
			t.index +
			"</td><td>" +
			(calls === ""
				? '<span class="muted">no tool call, final answer</span>'
				: calls) +
			'</td><td class="n">' +
			t.inTok.toLocaleString() +
			'</td><td class="n">' +
			t.outTok.toLocaleString() +
			"</td></tr>"
		);
	})
	.join("");

const bigCalls = turns
	.flatMap((t) => t.calls)
	.filter((c) => c.chars > 5000)
	.sort((a, b) => b.chars - a.chars);

const bigCallNote =
	bigCalls.length > 0
		? '<p style="margin-top:10px">The bill is dominated by single tool results, not by reasoning: ' +
			bigCalls
				.map(
					(c) =>
						"<code>" +
						esc(c.tool) +
						" " +
						c.chars.toLocaleString() +
						" ch</code>",
				)
				.join(", ") +
			". A prompt line that stops one broad grep is worth more than every wording edit combined.</p>"
		: "";

const multiPrompt =
	rows.filter((r) => r.taskId.startsWith("multi"))[0]?.promptTokensOurs ?? 0;

const variants: Array<[string, string, string, string]> = [
	[
		"v1",
		"Drop the duplicate <code>Query:</code> echo",
		num(promptOurs - 33, 0),
		"free win, no behavior change expected",
	],
	[
		"v2",
		"Drop the 4-step process block",
		num(promptOurs - 69, 0),
		"models already know find/grep/read; measure it",
	],
	[
		"v3",
		"Ask for grep-the-symbol before answering",
		num(promptOurs, 0),
		"attacks the 0.35 symbol loss and off-by-one citations",
	],
	[
		"v4",
		"Findings-first, prose capped at 150 words",
		num(promptOurs - 20, 0),
		"cuts output tokens and padding",
	],
	[
		"v5",
		"Terse rewrite, about 90 tokens total",
		"90",
		"the floor of what still works",
	],
	[
		"v6",
		"v3 and v4 combined",
		num(promptOurs, 0),
		"likely winner if both hold",
	],
];

const variantRows = variants
	.map(
		(v) =>
			'<tr><td class="mono">' +
			v[0] +
			"</td><td>" +
			v[1] +
			'</td><td class="n">~' +
			v[2] +
			'</td><td class="muted">' +
			v[3] +
			"</td></tr>",
	)
	.join("");

const taskShapes: Record<string, string> = {
	"plimit-clear-queue-error": "single repo, one behavior, 3 facts",
	"pqueue-equal-priority-fifo": "single repo, insertion algorithm, 3 facts",
	"consola-throttle-resolve": "single repo, timer and option, 3 facts",
	"multi-repo-queue-insert": "two repos, comparison, 2 facts",
	"consola-file-reporter": "negative: the fact is absent",
	"consola-options-type": "type lookup, 2 facts",
	"consola-log-pipeline": "call chain across 4 files, 4 facts",
	"pqueue-task-lifecycle": "call chain across 4 files, 4 facts",
};

const taskShapeRows = rows
	.map((r) => {
		const q = r.quality.toFixed(0);
		return (
			'<tr><td class="mono">' +
			esc(r.taskId) +
			'</td><td class="n">' +
			q +
			'</td><td class="muted">' +
			esc(taskShapes[r.taskId] ?? "") +
			"</td></tr>"
		);
	})
	.join("");

const html = [
	'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
	"<title>repo-query prompt benchmark</title><style>",
	":root{color-scheme:dark light}",
	"*{box-sizing:border-box}",
	"body{margin:0;font-family:var(--font-sans);color:var(--foreground);font-size:14px;line-height:1.5}",
	"h1{font-size:21px;line-height:1.25;margin:0 0 6px;font-weight:600;letter-spacing:-.01em}",
	"h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:26px 0 10px;font-weight:600}",
	"p{margin:0 0 10px}",
	".lede{color:var(--muted);max-width:72ch}",
	".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px;margin:16px 0 4px}",
	".tile{background:var(--card);border-radius:var(--radius);padding:12px 14px}",
	".tile .k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}",
	".tile .v{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px}",
	".tile .s{font-size:11px;color:var(--muted)}",
	"table{width:100%;border-collapse:collapse;font-size:12.5px}",
	"th{text-align:left;font-weight:600;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:0 8px 6px 0;border-bottom:1px solid var(--border)}",
	"td{padding:6px 8px 6px 0;border-bottom:1px solid var(--border);vertical-align:top}",
	"td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}",
	".mono{font-family:var(--font-mono);font-size:12px}",
	".muted{color:var(--muted)}.strong{font-weight:600}.warnc{color:var(--warning)}",
	".bar{display:flex;height:26px;border-radius:6px;overflow:hidden;margin:8px 0 10px}",
	".seg{height:100%}",
	".s0{background:var(--chart-1)}.s1{background:var(--chart-2)}.s2{background:var(--chart-3)}.s3{background:var(--chart-4)}.s4{background:var(--chart-5)}",
	".sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:7px}",
	".tag{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:1px 6px;border-radius:999px;margin-left:6px;vertical-align:1px}",
	".tag.bad{background:var(--destructive);color:var(--destructive-foreground)}",
	".tag.good{background:var(--success);color:var(--success-foreground)}",
	".tag.warn{background:var(--warning);color:var(--warning-foreground)}",
	".scatter{position:relative;height:230px;border-left:1px solid var(--border);border-bottom:1px solid var(--border);margin:10px 0 4px}",
	".dot{position:absolute;transform:translate(-50%,-50%);text-align:center}",
	'.dot::before{content:"";display:block;width:9px;height:9px;border-radius:50%;background:var(--chart-1);margin:0 auto}',
	".dotv{display:block;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1}",
	".axis{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:4px}",
	".call{display:flex;gap:8px;align-items:baseline;padding:1px 0;font-family:var(--font-mono);font-size:11.5px}",
	".call .tool{color:var(--chart-2);min-width:44px}",
	".call .args{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}",
	".call .chars{color:var(--muted);white-space:nowrap}",
	".call.big .chars{color:var(--warning);font-weight:600}",
	".two{display:grid;grid-template-columns:1fr 1fr;gap:14px}",
	"@media(max-width:720px){.two{grid-template-columns:1fr}}",
	"ul{margin:0;padding-left:18px}li{margin-bottom:4px}",
	".box{background:var(--card);border-radius:var(--radius);padding:16px}",
	"code{font-family:var(--font-mono);font-size:12px}",
	".foot{margin-top:22px;color:var(--muted);font-size:11.5px}",
	"</style></head><body>",

	"<h1>The repo-query prompt is about " +
		promptShare.toFixed(0) +
		"% of the bill. Its behavior is the rest.</h1>",
	'<p class="lede">A benchmark for the prompts behind <code>repo_query</code>: 8 tasks over 3 pinned repositories, 3 interleaved repeats, a deterministic scorer that verifies every citation against the clone, and a blind LLM judge from a different model family. The baseline is the current prompt, unmodified, on the model the tool will run.</p>',

	'<div class="grid">',
	'<div class="tile"><div class="k">Quality</div><div class="v">' +
		num(qualMean) +
		'</div><div class="s">det ' +
		num(detMean) +
		" / judge " +
		num(judgeMean) +
		"</div></div>",
	'<div class="tile"><div class="k">Judge disagreement</div><div class="v">' +
		disMean.toFixed(0) +
		'</div><div class="s">points per cell</div></div>',
	'<div class="tile"><div class="k">System prompt</div><div class="v">' +
		promptOurs.toFixed(0) +
		'</div><div class="s">tokens per call</div></div>',
	'<div class="tile"><div class="k">Billed per call</div><div class="v">' +
		billedK.toFixed(1) +
		'k</div><div class="s">' +
		turnsMean.toFixed(1) +
		" turns, " +
		callsMean.toFixed(0) +
		" tool calls</div></div>",
	'<div class="tile"><div class="k">Cost per call</div><div class="v">$' +
		costMean.toFixed(4) +
		'</div><div class="s">child + judge</div></div>',
	'<div class="tile"><div class="k">Cells</div><div class="v">' +
		cells.length +
		'</div><div class="s">' +
		rows.length +
		" tasks x " +
		report.repeat +
		" repeats</div></div>",
	"</div>",

	"<h2>Where a call's tokens actually go</h2>",
	"<p>Of " +
		billedK.toFixed(1) +
		"k billed tokens per call: " +
		(cacheMean / 1000).toFixed(1) +
		"k is re-sent context (" +
		((cacheMean / billed) * 100).toFixed(0) +
		"%), " +
		(inMean / 1000).toFixed(1) +
		"k new input, " +
		(outMean / 1000).toFixed(1) +
		"k output. The system prompt is re-sent every turn, so it accounts for about <strong>" +
		promptShare.toFixed(0) +
		"%</strong> of the bill, roughly " +
		(promptOurs * turnsMean).toFixed(0) +
		" tokens. Tool results are " +
		resCharsMean.toFixed(0) +
		" characters per call on average.</p>",
	'<p class="lede">Cutting the prompt from ' +
		promptOurs.toFixed(0) +
		" to 100 tokens saves about " +
		(promptOurs * turnsMean - 100 * turnsMean).toFixed(0) +
		" of " +
		billedK.toFixed(1) +
		"k. What the prompt really controls is whether the child searches efficiently: " +
		callsMean.toFixed(0) +
		" tool calls, " +
		(resCharsMean / 1000).toFixed(1) +
		"k characters of tool output, " +
		turnsMean.toFixed(1) +
		" turns. So the objective is quality per billed token, and prompt size is the tiebreaker.</p>",

	"<h2>The prompt under test, by section</h2>",
	'<div class="bar">' + sectionBars + "</div>",
	'<table><thead><tr><th>Section</th><th class="n">chars</th><th class="n">tokens</th><th>What it buys</th></tr></thead><tbody>',
	sectionRows,
	'<tr><td class="strong">Total</td><td class="n strong">' +
		sectionTotal +
		'</td><td class="n strong">' +
		promptOurs.toFixed(0) +
		'</td><td class="muted">single repo. The multi-repo branch adds the repo list and costs ' +
		multiPrompt.toFixed(0) +
		" tokens.</td></tr>",
	"</tbody></table>",
	'<p class="muted" style="margin-top:8px">Section sizes are exact characters. The token split is scaled from the measured total, so the total is exact and the per-section tokens are proportional estimates.</p>',

	"<h2>Baseline, per task</h2>",
	'<table><thead><tr><th>Task</th><th class="n">det</th><th class="n">judge</th><th class="n">combined</th><th class="n">disagree</th><th class="n">prompt</th><th class="n">billed</th><th class="n">q/1k</th><th class="n">calls</th></tr></thead><tbody>',
	taskRows,
	"</tbody></table>",
	'<p class="muted" style="margin-top:8px">Deterministic: 0.25 path + 0.35 symbol + 0.40 line, where the cited line must contain the symbol in the clone. Judge: blind, 1-5 on correctness, groundedness, usefulness. Combined is the mean. A disagreement above 15 points means the two axes read the answer differently, which is where the rubric needs a human look.</p>',

	"<h2>Efficiency frontier</h2>",
	'<div class="scatter">' + scatter + "</div>",
	'<div class="axis"><span>billed ' +
		(minBilled / 1000).toFixed(0) +
		"k tokens</span><span>quality " +
		qMin.toFixed(0) +
		"-" +
		qMax.toFixed(0) +
		"</span><span>" +
		(maxBilled / 1000).toFixed(0) +
		"k tokens</span></div>",
	'<p class="muted">Each dot is a task mean over 3 repeats. Best and cheapest is top left. The cheapest task reaches ' +
		Math.max(
			...rows.map((r) => r.quality / (r.billedTokens / 1000)),
		).toFixed(1) +
		" quality per 1k billed tokens; the most expensive costs " +
		(Math.max(...billeds) / Math.min(...billeds)).toFixed(1) +
		"x more for " +
		num(Math.max(...quals) - Math.min(...quals), 0) +
		" more quality points.</p>",

	"<h2>One call, end to end: " + esc(traceTask) + "</h2>",
	'<table><thead><tr><th class="n">turn</th><th>tool calls</th><th class="n">input</th><th class="n">output</th></tr></thead><tbody>',
	turnRows,
	"</tbody></table>",
	bigCallNote,
	'<p class="muted" style="margin-top:10px">Answer, as the parent receives it:</p>',
	'<div class="box mono" style="max-height:210px;overflow:auto;white-space:pre-wrap;font-size:11.5px">' +
		esc(answer.slice(0, 1400)) +
		(answer.length > 1400 ? "…" : "") +
		"</div>",

	"<h2>The 8 tasks</h2>",
	'<table><thead><tr><th>Task</th><th class="n">quality</th><th>Shape</th></tr></thead><tbody>',
	taskShapeRows,
	"</tbody></table>",

	"<h2>Two production bugs the benchmark found</h2>",
	'<div class="two">',
	'<div class="box"><strong>Multi-repo findings were always unverified.</strong><p class="muted" style="margin-top:6px">The multi-repo prompt passed the literal string <code>owner/repo</code> as the findings example, so every finding a child copied was unmappable and marked <code>verified: false</code>. Fixed: the example names a real repository. Single-repo prompt bytes are unchanged.</p></div>',
	'<div class="box"><strong>Truncation threw away the findings block.</strong><p class="muted" style="margin-top:6px">Answers were cut to 8,000 characters before findings were parsed, and the block is last. A long answer lost its structured payload. Fixed: the prose is cut, the block survives, and <code>complete</code> stays honest.</p></div>',
	"</div>",

	"<h2>What this benchmark cannot see</h2>",
	'<ul class="muted"><li>Anything outside the listed facts. A confident wrong answer that cites the listed lines still scores well deterministically.</li>',
	"<li>An honest answer that never typed the symbol in a tool argument loses 0.35 per fact. This is the largest source of judge disagreement and the first thing the loop should fix behaviorally.</li>",
	"<li>The clone step, the extension wiring, the parent's conversation, or the absolute cost of a real call.</li>",
	"<li>Cross-model comparison: scores are comparable only within one child model and thinking level.</li>",
	"<li>Eight tasks is a small sample. Quality moved more than 30 points between repeats on two tasks, which is why every verdict uses paired per-task deltas, not a mean.</li></ul>",

	"<h2>The loop this enables</h2>",
	'<table><thead><tr><th>Variant</th><th>Change</th><th class="n">est. tokens</th><th>Hypothesis</th></tr></thead><tbody>',
	variantRows,
	"</tbody></table>",
	'<p style="margin-top:10px">A candidate wins only when it beats the baseline on <strong>at least 5 of 8 tasks</strong> by paired quality delta, loses none, and holds or lowers billed tokens. Prompt tokens break ties. Every verdict is re-run with the judge on 5 repeats before it is called.</p>',

	'<p class="foot">Run <code>' +
		esc(report.stamp) +
		"</code> · child <code>" +
		esc(report.model) +
		"</code> thinking " +
		esc(report.thinking) +
		" · judge <code>" +
		esc(report.judgeModel) +
		"</code> thinking " +
		esc(report.judgeThinking) +
		" · pi " +
		esc(report.piVersion) +
		" · seed " +
		report.seed +
		" · $" +
		report.totalCostUsd.toFixed(4) +
		" total, $" +
		report.judgeCostUsd.toFixed(4) +
		" of it judge. Reproduce: <code>node bench/run.ts --variants v0 --tasks all --repeat 3</code>.</p>",

	"</body></html>",
].join("\n");

process.stdout.write(html);
