import {
	type AgentToolResult,
	getMarkdownTheme,
	keyHint,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Markdown,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { formatRepoDisplayName } from "./output.js";
import type { RepoQueryDetails, RepoStatus } from "./types.js";
import { isFailure, isSuccess } from "./types.js";

/**
 * Container subclass for repo_query result rendering. The subclass identity
 * lets renderResult reuse the component across successive render calls via
 * context.lastComponent.
 */
export class RepoQueryResultComponent extends Container {}

/** Per-call render state tracked on context.state. */
export interface RepoQueryRenderState {
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
}

/**
 * Structural subset of pi's tool render context that the renderers need.
 * pi's ToolRenderContext satisfies it.
 */
export interface ToolRenderLike {
	executionStarted: boolean;
	lastComponent: Component | undefined;
	state: unknown;
	invalidate: () => void;
}

type StatusTone = "success" | "warning" | "error" | "dim";

function statusColor(status: RepoStatus): StatusTone {
	if (isSuccess(status)) {
		return status === "success" ? "success" : "warning";
	}
	if (isFailure(status)) return "error";
	return "dim";
}

function statusIcon(status: RepoStatus, theme: Theme): string {
	const glyph =
		status === "success"
			? "✓"
			: status === "archived"
				? "⚠"
				: statusColor(status) === "error"
					? "✗"
					: "⏳";
	return theme.fg(statusColor(status), glyph);
}

function headerIcon(allFailed: boolean, theme: Theme): string {
	return allFailed ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

/**
 * Append a duration line to the component if timing information is available.
 * Shows "Elapsed: X.Xs" during partial execution, "Took: X.Xs" when complete.
 */
function appendDurationLine(
	component: RepoQueryResultComponent,
	theme: Theme,
	startedAt?: number,
	endedAt?: number,
): void {
	if (startedAt === undefined) return;
	const now = endedAt ?? Date.now();
	const elapsed = ((now - startedAt) / 1000).toFixed(1);
	const label = endedAt !== undefined ? "Took" : "Elapsed";
	component.addChild(
		new Text(theme.fg("dim", `${label}: ${elapsed}s`), 0, 0),
	);
}

function usageLine(
	usage: NonNullable<RepoQueryDetails["usage"]>,
	theme: Theme,
): string {
	return theme.fg(
		"dim",
		`${usage.turns} ${usage.turns === 1 ? "turn" : "turns"} · ${usage.totalTokens} tokens · $${usage.cost.toFixed(4)}`,
	);
}

/**
 * Clear and repopulate a RepoQueryResultComponent based on the current result state.
 * Handles all three render paths: partial (streaming), expanded (rich layout), collapsed (summary).
 */
function rebuildRepoQueryResultComponent(
	component: RepoQueryResultComponent,
	result: AgentToolResult<RepoQueryDetails>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	startedAt?: number,
	endedAt?: number,
): void {
	component.clear();

	const details = result.details as RepoQueryDetails | undefined;
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		component.addChild(
			new Text(text?.type === "text" ? text.text : "(no output)", 0, 0),
		);
		appendDurationLine(component, theme, startedAt, endedAt);
		return;
	}

	const mdTheme = getMarkdownTheme();
	const hasAnswer = Boolean(details.answer);
	const allFailed = details.results.every((r) => isFailure(r.status));

	// Streaming / partial state — repo status + last 5 thought lines
	if (options.isPartial) {
		const lines: string[] = [];

		for (const r of details.results) {
			const activity =
				r.status === "success"
					? theme.fg("dim", "ready")
					: r.status === "archived"
						? theme.fg("warning", "archived")
						: r.status === "not_found"
							? theme.fg("error", "not found")
							: r.status === "clone_failed"
								? theme.fg("error", "clone failed")
								: r.status === "skipped"
									? theme.fg("error", "skipped")
									: theme.fg("dim", "pending");
			lines.push(
				`  ${statusIcon(r.status, theme)} ${theme.fg("accent", r.identifier)} ${activity}`,
			);
			if (r.suggestions && r.suggestions.length > 0) {
				lines.push(
					`    ${theme.fg("dim", `→ did you mean: ${r.suggestions[0]}?`)}`,
				);
			}
		}

		// Show last 5 lines of subagent thought
		const thought = details.thought ?? "";
		if (thought) {
			const thoughtLines = thought.split("\n").filter((l) => l.trim());
			const lastLines = thoughtLines.slice(-5);
			if (thoughtLines.length > 5) {
				lines.push(theme.fg("dim", "..."));
			}
			for (const line of lastLines) {
				lines.push(`  ${theme.fg("dim", line.trim())}`);
			}
		}

		for (const line of lines) {
			component.addChild(new Text(line, 0, 0));
		}
		appendDurationLine(component, theme, startedAt, endedAt);
		return;
	}

	// Expanded view: rich layout with Container + Markdown
	if (options.expanded && hasAnswer) {
		const successCount = details.results.filter(
			(r) => r.status === "success" || r.status === "archived",
		).length;
		component.addChild(
			new Text(
				`${headerIcon(allFailed, theme)} ${theme.fg("toolTitle", theme.bold("repo_query"))} ${theme.fg("accent", `${successCount}/${details.results.length}`)}`,
				0,
				0,
			),
		);
		component.addChild(new Spacer(1));

		// Query
		component.addChild(new Text(theme.fg("muted", "Query:"), 0, 0));
		component.addChild(new Text(theme.fg("dim", details.query), 0, 0));
		component.addChild(new Spacer(1));

		// Model
		if (details.model) {
			component.addChild(new Text(theme.fg("muted", "Model:"), 0, 0));
			component.addChild(new Text(theme.fg("dim", details.model), 0, 0));
			component.addChild(new Spacer(1));
		}

		// Workspace
		if (details.workspacePath) {
			component.addChild(new Text(theme.fg("muted", "Workspace:"), 0, 0));
			component.addChild(
				new Text(theme.fg("dim", details.workspacePath), 0, 0),
			);
			component.addChild(new Spacer(1));
		}

		// Subagent usage (nested LLM calls)
		if (details.usage) {
			component.addChild(new Text(theme.fg("muted", "Usage:"), 0, 0));
			component.addChild(new Text(usageLine(details.usage, theme), 0, 0));
			component.addChild(new Spacer(1));
		}

		// Repositories
		component.addChild(new Text(theme.fg("muted", "Repositories:"), 0, 0));
		for (const r of details.results) {
			let line = `  ${statusIcon(r.status, theme)} ${theme.fg("accent", r.identifier)}`;
			if (r.localPath) line += theme.fg("dim", ` → ${r.localPath}`);
			component.addChild(new Text(line, 0, 0));
			if (r.warnings.length > 0) {
				component.addChild(
					new Text(`    ${theme.fg("warning", r.warnings[0])}`, 0, 0),
				);
			}
			if (r.error) {
				component.addChild(
					new Text(`    ${theme.fg("error", r.error)}`, 0, 0),
				);
			}
			if (r.suggestions && r.suggestions.length > 0) {
				component.addChild(
					new Text(
						`    ${theme.fg("dim", `Did you mean: ${r.suggestions.join(", ")}?`)}`,
						0,
						0,
					),
				);
			}
		}
		component.addChild(new Spacer(1));

		// Answer as Markdown
		if (details.answer) {
			component.addChild(new Text(theme.fg("muted", "Answer:"), 0, 0));
			component.addChild(
				new Markdown(details.answer.trim(), 0, 0, mdTheme),
			);
		}
		appendDurationLine(component, theme, startedAt, endedAt);
		return;
	}

	// Collapsed view
	const successCount = details.results.filter(
		(r) => r.status === "success" || r.status === "archived",
	).length;
	component.addChild(
		new Text(
			`${headerIcon(allFailed, theme)} ${theme.fg("toolTitle", theme.bold("repo_query"))} ${theme.fg("accent", `${successCount}/${details.results.length}`)}`,
			0,
			0,
		),
	);

	for (const r of details.results.slice(0, 3)) {
		let line = `${statusIcon(r.status, theme)} ${theme.fg("accent", r.identifier)}`;
		if (r.warnings.length > 0) {
			line += ` ${theme.fg("warning", r.warnings[0].substring(0, 40))}`;
			if (r.warnings[0].length > 40) line += theme.fg("dim", "...");
		}
		component.addChild(new Text(line, 0, 0));
		if (r.error) {
			component.addChild(
				new Text(
					`  ${theme.fg("error", r.error.substring(0, 60))}`,
					0,
					0,
				),
			);
			if (r.error.length > 60)
				component.addChild(new Text(theme.fg("dim", "..."), 0, 0));
		}
	}
	if (details.results.length > 3) {
		component.addChild(
			new Text(
				theme.fg("muted", `... +${details.results.length - 3} more`),
				0,
				0,
			),
		);
	}

	if (hasAnswer) {
		component.addChild(
			new Text(keyHint("app.tools.expand", "to expand"), 0, 0),
		);
	}

	appendDurationLine(component, theme, startedAt, endedAt);
}

/** Render the tool-call header line. */
export function renderCall(
	args: { query: string; repos: string[] },
	theme: Theme,
	context: ToolRenderLike,
): Component {
	const state = context?.state as RepoQueryRenderState | undefined;
	if (context?.executionStarted && state && state.startedAt === undefined) {
		state.startedAt = Date.now();
		state.endedAt = undefined;
	}

	const text =
		context?.lastComponent instanceof Text
			? context.lastComponent
			: new Text("", 0, 0);

	const repoList = args.repos.slice(0, 3).map((r: string) => {
		const { display, branch } = formatRepoDisplayName(r);
		return branch ? `${display}:${theme.fg("dim", branch)}` : display;
	});
	let repoText = repoList.join(", ");
	if (args.repos.length > 3) {
		repoText += theme.fg("muted", ` +${args.repos.length - 3}`);
	}

	let textContent = theme.fg("toolTitle", theme.bold("repo_query "));
	textContent += theme.fg("dim", repoText);
	textContent += `\n  ${theme.fg("muted", `"${args.query}"`)}`;
	text.setText(textContent);
	return text;
}

/** Render the tool result: partial (streaming), expanded, or collapsed. */
export function renderResult(
	result: AgentToolResult<RepoQueryDetails>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: ToolRenderLike,
): Component {
	const state = context?.state as RepoQueryRenderState | undefined;

	// Set startedAt if execution has started and we haven't tracked it yet
	if (state && context?.executionStarted && state.startedAt === undefined) {
		state.startedAt = Date.now();
		state.endedAt = undefined;
	}

	// Live elapsed-time counter: start interval during partial exploration
	if (
		state &&
		state.startedAt !== undefined &&
		options.isPartial &&
		state.interval === undefined
	) {
		state.interval = setInterval(() => context?.invalidate(), 1000);
	}

	// Stop timer when the result is complete
	if (state && !options.isPartial) {
		state.endedAt ??= Date.now();
		if (state.interval !== undefined) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
	}

	const component =
		context?.lastComponent instanceof RepoQueryResultComponent
			? context.lastComponent
			: new RepoQueryResultComponent();

	rebuildRepoQueryResultComponent(
		component,
		result,
		options,
		theme,
		state?.startedAt,
		state?.endedAt,
	);
	component.invalidate();
	return component;
}
