import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { CACHE_DIR } from "./clones.ts";
import { parseFindingsBlock, verifyFindings } from "./score.ts";

/**
 * Print a readable timeline for one child run.
 *
 * Usage:
 *   node bench/trace.ts runs/<stamp>/cells/v0/<task>.jsonl
 *
 * Findings are checked against the cached clones, which no child ever writes
 * to, so the verification here matches what the extension would report.
 */

interface ToolEvent {
	name: string;
	args: Record<string, unknown>;
	chars: number;
	isError: boolean;
	durationMs: number | null;
}

interface Turn {
	index: number;
	tools: ToolEvent[];
	input: number;
	output: number;
	cacheRead: number;
	text: string;
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

/** One short line that identifies the call. */
function summariseArgs(name: string, args: Record<string, unknown>): string {
	const pick = (key: string): string | null =>
		typeof args[key] === "string" ? (args[key] as string) : null;

	const parts: string[] = [];
	const pattern = pick("pattern");
	if (pattern !== null) parts.push(`"${pattern}"`);
	const command = pick("command");
	if (command !== null) parts.push(command.replace(/\s+/g, " ").slice(0, 70));
	const path = pick("path") ?? pick("file");
	if (path !== null) parts.push(path);
	const query = pick("query");
	if (query !== null) parts.push(`query "${query.slice(0, 60)}"`);
	for (const key of ["offset", "limit", "glob", "ignoreCase", "literal"]) {
		const value = args[key];
		if (typeof value === "number" || typeof value === "boolean") {
			parts.push(`${key}=${value}`);
		}
	}
	return parts.length === 0
		? `${name} ${JSON.stringify(args).slice(0, 70)}`
		: `${name} ${parts.join(" ")}`;
}

/** Cached clones, keyed by the path a finding would use. */
function cachedClones(): Map<string, string> {
	const clones = new Map<string, string>();
	if (!existsSync(CACHE_DIR)) return clones;
	for (const entry of readdirSync(CACHE_DIR)) {
		const match = /^([^@]+)@(.+)$/.exec(entry);
		if (match === null) continue;
		const slug = match[1];
		const path = join(CACHE_DIR, entry);
		const [owner, repo] = slug.split("__");
		if (owner === undefined || repo === undefined) continue;
		clones.set(`${owner}/${repo}`, path);
	}
	return clones;
}

function main(): number {
	const target = process.argv[2];
	if (target === undefined) {
		console.error("usage: node bench/trace.ts <run.jsonl>");
		return 2;
	}
	const absolute = resolve(target);
	if (!existsSync(absolute)) {
		console.error(`No such file: ${absolute}`);
		return 2;
	}

	const lines = readFileSync(absolute, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0);

	const turns: Turn[] = [];
	const openTools = new Map<
		string,
		{ name: string; args: Record<string, unknown> }
	>();
	let session: Record<string, unknown> | undefined;
	let answer = "";
	let cumulative = 0;
	let totalToolChars = 0;
	let totalToolCalls = 0;

	for (const line of lines) {
		let event: Record<string, unknown> | undefined;
		try {
			event = asRecord(JSON.parse(line));
		} catch {
			continue;
		}
		if (event === undefined) continue;

		if (event.type === "session") {
			session = event;
			continue;
		}

		if (event.type === "turn_start") {
			turns.push({
				index: turns.length + 1,
				tools: [],
				input: 0,
				output: 0,
				cacheRead: 0,
				text: "",
			});
			continue;
		}

		if (event.type === "tool_execution_start") {
			const id =
				typeof event.toolCallId === "string" ? event.toolCallId : "";
			openTools.set(id, {
				name: typeof event.toolName === "string" ? event.toolName : "?",
				args: asRecord(event.args) ?? {},
			});
			continue;
		}

		if (event.type === "tool_execution_end") {
			const id =
				typeof event.toolCallId === "string" ? event.toolCallId : "";
			const open = openTools.get(id);
			if (open === undefined) continue;
			openTools.delete(id);
			const chars = textOf(asRecord(event.result)?.content).length;
			totalToolChars += chars;
			totalToolCalls++;
			turns.at(-1)?.tools.push({
				name: open.name,
				args: open.args,
				chars,
				isError: event.isError === true,
				durationMs:
					typeof event.durationMs === "number"
						? event.durationMs
						: null,
			});
			continue;
		}

		if (event.type !== "message_end") continue;
		const message = asRecord(event.message);
		if (message?.role !== "assistant") continue;
		const usage = asRecord(message.usage);
		const turn = turns.at(-1);
		if (turn !== undefined) {
			turn.input += numberOf(usage?.input);
			turn.output += numberOf(usage?.output);
			turn.cacheRead += numberOf(usage?.cacheRead);
		}
		const text = textOf(message.content);
		if (text.length > 0) answer = text;
	}

	console.log(`repo-query trace — ${absolute}`);
	if (session !== undefined) {
		console.log(
			`session ${String(session.id ?? "?")} cwd ${String(session.cwd ?? "?")}`,
		);
	}

	for (const turn of turns) {
		cumulative += turn.input + turn.output;
		console.log("");
		console.log(
			`turn ${turn.index}: ${turn.tools.length} tool call(s), in ${turn.input}, out ${turn.output}, cacheRead ${turn.cacheRead}, cumulative ${cumulative}`,
		);
		for (const tool of turn.tools) {
			const size = `${tool.chars} chars`;
			const ms = tool.durationMs === null ? "" : ` ${tool.durationMs} ms`;
			const failed = tool.isError ? " FAILED" : "";
			console.log(
				`  -> ${summariseArgs(tool.name, tool.args)}  ${size}${ms}${failed}`,
			);
		}
	}

	console.log("");
	console.log(
		`totals: ${turns.length} turn(s), ${totalToolCalls} tool call(s), ${totalToolChars} tool-result chars, ${cumulative} tokens`,
	);

	const { prose, findings } = parseFindingsBlock(answer);
	const checked = verifyFindings(findings, cachedClones());

	console.log("");
	console.log(
		`answer (${prose.split(/\s+/).filter((word) => word.length > 0).length} words):`,
	);
	console.log(prose.trim());

	console.log("");
	console.log(`findings (${checked.length}):`);
	if (checked.length === 0) {
		console.log("  none");
	}
	for (const finding of checked) {
		const where = `${finding.path}${finding.line === null ? "" : `:${finding.line}`}`;
		const state = finding.verified
			? "verified"
			: finding.exists
				? "line out of range"
				: "path not found";
		console.log(`  [${state}] ${where} — ${finding.claim}`);
	}

	return 0;
}

process.exit(main());
