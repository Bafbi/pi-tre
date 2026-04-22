import { rm } from "node:fs/promises";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	getMarkdownTheme,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { ensureRepoCloned } from "./clone.js";
import {
	addDebugEvent,
	buildDebugDump,
	createDebugState,
	setDebugEnabled,
	setWorkspacePath,
	syncDebugUi,
	trackRepo,
} from "./debug.js";
import { runExplorer } from "./explorer.js";
import { validateGitHubRepo } from "./github.js";
import { parseRepoIdentifier } from "./resolver.js";
import type { RepoQueryDetails, RepoQueryPhase, RepoResult } from "./types.js";
import { clearWorkspaceCache, getWorkspacePath } from "./workspace.js";

const MAX_REPOS = 5;

const RepoQueryParams = Type.Object({
	query: Type.String({
		description: "The question or task to answer by exploring the repositories",
	}),
	repos: Type.Array(
		Type.String({
			description:
				"Repository identifiers. Examples: 'owner/repo', 'owner/repo:branch', 'https://github.com/org/repo@branch', 'git@gitlab.com:org/repo.git'",
		}),
		{ minItems: 1, maxItems: MAX_REPOS },
	),
});

export default function (pi: ExtensionAPI) {
	// Track active temp directories for emergency cleanup
	const activeWorkspaces = new Set<string>();
	const debug = createDebugState();

	pi.on("session_start", async (_event, ctx) => {
		debug.events.length = 0;
		debug.trackedRepos.clear();
		debug.workspacePath = null;
		addDebugEvent(debug, "session_start: state reset", ctx);
	});

	pi.on("session_shutdown", async () => {
		clearWorkspaceCache();
		for (const ws of activeWorkspaces) {
			try {
				await rm(ws, { recursive: true, force: true });
			} catch {
				/* ignore cleanup errors */
			}
		}
		activeWorkspaces.clear();
	});

	pi.registerCommand("repo-query-debug", {
		description: "Debug repo-query (on|off|status|toggle|dump)",
		handler: async (args, ctx) => {
			const [subcommandRaw] = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = subcommandRaw ?? "toggle";

			switch (subcommand) {
				case "on": {
					setDebugEnabled(debug, true, ctx);
					addDebugEvent(debug, "debug enabled", ctx);
					break;
				}
				case "off": {
					setDebugEnabled(debug, false, ctx);
					addDebugEvent(debug, "debug disabled", ctx);
					break;
				}
				case "status": {
					addDebugEvent(debug, "debug status requested", ctx);
					break;
				}
				case "dump": {
					const report = buildDebugDump(debug, ctx);
					addDebugEvent(debug, "debug dump generated", ctx);
					if (ctx.hasUI) {
						ctx.ui.setEditorText(report);
						ctx.ui.notify("repo-query debug dump copied to editor", "info");
					}
					break;
				}
				case "toggle": {
					setDebugEnabled(debug, !debug.enabled, ctx);
					addDebugEvent(debug, `debug ${debug.enabled ? "enabled" : "disabled"} (toggle)`, ctx);
					break;
				}
				default: {
					if (ctx.hasUI) {
						ctx.ui.notify("Unknown subcommand. Use: /repo-query-debug [on|off|status|toggle|dump]", "warning");
					}
					return;
				}
			}

			if (ctx.hasUI && subcommand !== "dump") {
				const status = debug.enabled ? "ON" : "OFF";
				ctx.ui.notify(`repo-query debug: ${status}`, "info");
			}
		},
	});

	pi.registerTool({
		name: "repo_query",
		label: "Repo Query",
		description: [
			"Explore one or more git repositories to answer a query.",
			"Clones repositories via shallow clone and delegates exploration to a subagent.",
			"Supports GitHub shorthand ('owner/repo'), full URLs, and branch suffixes (:branch or @branch).",
			"GitHub repos are validated via API; non-existent repos return search suggestions.",
			"Repositories are cached per session and reused across multiple queries.",
		].join(" "),
		promptSnippet: "Query git repositories by cloning them and exploring with a subagent",
		promptGuidelines: [
			"Use repo_query when you need to investigate code in external repositories.",
			"Provide specific queries; the subagent will search and read relevant files.",
			"Multiple repositories enable cross-repo comparison and reference finding.",
		],
		parameters: RepoQueryParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			addDebugEvent(
				debug,
				`execute: query="${params.query.substring(0, 60)}..." repos=[${params.repos.join(", ")}]`,
				ctx,
			);

			const workspace = await getWorkspacePath(ctx);
			activeWorkspaces.add(workspace);
			setWorkspacePath(debug, workspace);
			addDebugEvent(debug, `workspace: ${workspace}`, ctx);

			const results: RepoResult[] = [];
			const reposToExplore: Array<{ parsed: ReturnType<typeof parseRepoIdentifier>; dirName: string }> = [];

			const buildThought = (phase: RepoQueryPhase): string => {
				const names = params.repos
					.slice(0, 2)
					.map((r) => {
						const m = r.match(/[:@]([^/]+)$/);
						return m ? r.slice(0, -m[0].length) : r;
					})
					.join(", ");
				const rest = params.repos.length > 2 ? ` and ${params.repos.length - 2} more` : "";
				switch (phase) {
					case "parsing":
						return `Looking up ${names}${rest}...`;
					case "validating":
						return `Checking ${names}${rest} on GitHub...`;
					case "cloning":
						return `Cloning ${names}${rest} to search for "${params.query}"...`;
					case "exploring":
						return `Searching ${names}${rest} for "${params.query}"...`;
					case "complete":
						return `Done exploring ${names}${rest}.`;
				}
			};

			const makeDetails = (phase: RepoQueryPhase, thoughtOverride?: string): RepoQueryDetails => ({
				query: params.query,
				workspacePath: workspace,
				results: [...results],
				phase,
				thought: thoughtOverride || buildThought(phase),
			});

			const emitPhase = (phase: RepoQueryPhase) => {
				onUpdate?.({
					content: [{ type: "text", text: "" }],
					details: makeDetails(phase),
				});
			};

			// ── Phase 1: Parse and validate ─────────────────────────────
			emitPhase("parsing");
			addDebugEvent(debug, "phase: parse and validate", ctx);
			for (const raw of params.repos) {
				let parsed: ReturnType<typeof parseRepoIdentifier>;
				try {
					parsed = parseRepoIdentifier(raw);
					addDebugEvent(
						debug,
						`parsed: ${raw} → ${parsed.host}/${parsed.displayName} (branch=${parsed.branch ?? "default"})`,
						ctx,
					);
				} catch (err) {
					addDebugEvent(debug, `parse failed: ${raw} → ${err instanceof Error ? err.message : String(err)}`, ctx);
					results.push({
						identifier: raw,
						status: "skipped",
						warnings: [],
						error: `Cannot parse identifier: ${err instanceof Error ? err.message : String(err)}`,
					});
					emitPhase("parsing");
					continue;
				}

				trackRepo(debug, raw, { status: "parsed", cloned: false, branch: parsed.branch });

				// GitHub-specific validation
				if (parsed.host === "github" && parsed.owner && parsed.repo) {
					emitPhase("validating");
					try {
						addDebugEvent(debug, `github validate: ${parsed.owner}/${parsed.repo}`, ctx);
						const validation = await validateGitHubRepo(parsed.owner, parsed.repo);
						if (!validation.valid) {
							addDebugEvent(
								debug,
								`github not_found: ${parsed.displayName} suggestions=[${validation.suggestions?.join(", ") ?? ""}]`,
								ctx,
							);
							results.push({
								identifier: raw,
								status: "not_found",
								cloneUrl: parsed.cloneUrl,
								warnings: [],
								suggestions: validation.suggestions,
								error: `Repository '${parsed.displayName}' not found on GitHub.`,
							});
							trackRepo(debug, raw, { status: "not_found", cloned: false });
							emitPhase("validating");
							continue;
						}
						if (validation.warning) {
							addDebugEvent(debug, `github archived: ${parsed.displayName}`, ctx);
							results.push({
								identifier: raw,
								status: "archived",
								cloneUrl: parsed.cloneUrl,
								warnings: [validation.warning],
							});
							trackRepo(debug, raw, { status: "archived", cloned: false });
							// Still add to explore list
						}
					} catch (err) {
						// GitHub API failure — don't block, proceed with clone attempt
						addDebugEvent(
							debug,
							`github api error: ${parsed.displayName} → ${err instanceof Error ? err.message : String(err)}`,
							ctx,
						);
						results.push({
							identifier: raw,
							status: "skipped",
							cloneUrl: parsed.cloneUrl,
							warnings: [
								`GitHub API check failed: ${err instanceof Error ? err.message : String(err)}. Proceeding with clone attempt.`,
							],
						});
					}
				}

				reposToExplore.push({ parsed, dirName: parsed.dirName });
				emitPhase("validating");
			}

			// ── Phase 2: Clone ──────────────────────────────────────────
			addDebugEvent(debug, `phase: clone (${reposToExplore.length} repos to clone)`, ctx);
			for (const { parsed } of reposToExplore) {
				// Check if already have a result (e.g., archived warning)
				const existing = results.find((r) => r.identifier === parsed.raw);
				if (existing && existing.status === "not_found") continue;

				emitPhase("cloning");
				addDebugEvent(debug, `clone start: ${parsed.raw} → ${parsed.dirName}`, ctx);
				const cloneResult = await ensureRepoCloned(parsed, workspace, signal, pi);
				addDebugEvent(
					debug,
					`clone result: ${parsed.raw} → ${cloneResult.status}${cloneResult.error ? ` (${cloneResult.error})` : ""}`,
					ctx,
				);

				if (cloneResult.status === "failed") {
					// Update or add result
					if (existing) {
						existing.status = "clone_failed";
						existing.error = cloneResult.error;
					} else {
						results.push({
							identifier: parsed.raw,
							status: "clone_failed",
							cloneUrl: parsed.cloneUrl,
							warnings: [],
							error: cloneResult.error,
						});
					}
					trackRepo(debug, parsed.raw, { status: "clone_failed", cloned: false });
				} else if (!existing) {
					results.push({
						identifier: parsed.raw,
						status: "success",
						cloneUrl: parsed.cloneUrl,
						localPath: `${workspace}/${parsed.dirName}`,
						warnings: [],
					});
					trackRepo(debug, parsed.raw, { status: "cloned", cloned: true, branch: parsed.branch });
				} else {
					trackRepo(debug, parsed.raw, { status: existing.status, cloned: true, branch: parsed.branch });
				}
				emitPhase("cloning");
			}

			// ── Phase 3: Explore ────────────────────────────────────────
			const readyRepos = reposToExplore.filter(({ parsed }) => {
				const result = results.find((r) => r.identifier === parsed.raw);
				return result && (result.status === "success" || result.status === "archived");
			});

			addDebugEvent(debug, `phase: explore (${readyRepos.length} ready repos)`, ctx);

			if (readyRepos.length === 0) {
				addDebugEvent(debug, "explore: no ready repos, returning error", ctx);
				const errorParts = results.filter((r) => r.error).map((r) => `- ${r.identifier}: ${r.error}`);

				const suggestionParts = results
					.filter((r) => r.suggestions && r.suggestions.length > 0)
					.map((r) => `- ${r.identifier}: did you mean ${r.suggestions?.join(", ")}?`);

				const text = ["No repositories could be explored.", ...errorParts, ...suggestionParts].join("\n");

				return {
					content: [{ type: "text", text }],
					details: makeDetails("complete"),
					isError: true,
				};
			}

			emitPhase("exploring");
			addDebugEvent(debug, `subagent spawn: ${readyRepos.length} repo(s)`, ctx);
			const exploration = await runExplorer({
				workspace,
				repos: readyRepos.map((r) => r.parsed),
				query: params.query,
				signal,
				onUpdate: (partial) => {
					// Update the result text with streaming answer
					const text = partial.content[0]?.type === "text" ? partial.content[0].text : "";
					if (text) {
						// Find first success/Archived result and attach answer
						for (const r of results) {
							if (r.status === "success" || r.status === "archived") {
								r.answer = text;
								break;
							}
						}
					}
					// Stream actual subagent thinking if available
					const subagentThought =
						partial.details && typeof partial.details === "object" && "thought" in partial.details
							? String((partial.details as Record<string, unknown>).thought)
							: "";
					onUpdate?.({
						content: partial.content,
						details: makeDetails("exploring", subagentThought || undefined),
					});
				},
			});

			if (exploration.error) {
				addDebugEvent(debug, `explore failed: ${exploration.error.substring(0, 120)}`, ctx);
				for (const r of results) {
					if (r.status === "success" || r.status === "archived") {
						r.status = "exploration_failed";
						r.error = exploration.error;
					}
				}
			} else {
				addDebugEvent(debug, `explore success: answer=${exploration.answer.length} chars`, ctx);
				// Attach answer to all explored repos
				for (const r of results) {
					if (r.status === "success" || r.status === "archived") {
						r.answer = exploration.answer;
					}
				}
			}

			// ── Phase 4: Synthesize output ──────────────────────────────
			const outputText = formatOutput(results, params.query);

			// Truncate if needed
			const truncation = truncateHead(outputText, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const hasErrors = results.some(
				(r) => r.status === "not_found" || r.status === "clone_failed" || r.status === "exploration_failed",
			);

			addDebugEvent(debug, `execute complete: ${hasErrors ? "with errors" : "success"}`, ctx);

			return {
				content: [{ type: "text", text: truncation.content }],
				details: makeDetails("complete"),
				isError: hasErrors && readyRepos.length === 0,
			};
		},

		renderCall(args, theme, _context) {
			const repoList = args.repos.slice(0, 3).map((r: string) => {
				const branchMatch = r.match(/[:@]([^/]+)$/);
				const base = branchMatch ? r.slice(0, -branchMatch[0].length) : r;
				const branch = branchMatch ? branchMatch[1] : null;
				return branch ? `${base}:${theme.fg("dim", branch)}` : base;
			});
			let repoText = repoList.join(", ");
			if (args.repos.length > 3) {
				repoText += theme.fg("muted", ` +${args.repos.length - 3}`);
			}

			let text = theme.fg("toolTitle", theme.bold("repo_query "));
			text += theme.fg("accent", `${args.repos.length}`);
			text += `\n  ${theme.fg("dim", `"${args.query}"`)}`;
			text += `\n  ${theme.fg("muted", repoText)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			const details = result.details as RepoQueryDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const hasAnswer = details.results.some((r) => r.answer);
			const allFailed = details.results.every(
				(r) =>
					r.status === "not_found" ||
					r.status === "clone_failed" ||
					r.status === "exploration_failed" ||
					r.status === "skipped",
			);

			// Streaming / partial state — show header + repos + last 5 lines of thought
			if (isPartial) {
				const repoList = details.results
					.map((r) => {
						const m = r.identifier.match(/[:@]([^/]+)$/);
						return m ? r.identifier.slice(0, -m[0].length) : r.identifier;
					})
					.join(", ");

				let text = theme.fg("toolTitle", theme.bold("repo_query "));
				text += theme.fg("dim", repoList);
				text += `\n  ${theme.fg("muted", `"${details.query}"`)}`;

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
					const icon =
						r.status === "success" || r.status === "archived"
							? theme.fg("success", "✓")
							: r.status === "not_found" || r.status === "clone_failed" || r.status === "skipped"
								? theme.fg("error", "✗")
								: theme.fg("warning", "⏳");
					text += `\n  ${icon} ${theme.fg("accent", r.identifier)} ${activity}`;
					if (r.suggestions && r.suggestions.length > 0) {
						text += `\n    ${theme.fg("dim", `→ did you mean: ${r.suggestions[0]}?`)}`;
					}
				}

				// Show last 5 lines of subagent thought
				const thought = details.thought ?? "";
				if (thought) {
					const lines = thought.split("\n").filter((l) => l.trim());
					const lastLines = lines.slice(-5);
					if (lines.length > 5) {
						text += `\n${theme.fg("dim", "...")}`;
					}
					for (const line of lastLines) {
						text += `\n${theme.fg("thinkingText", "💭")} ${theme.fg("dim", line.trim())}`;
					}
				}

				return new Text(text, 0, 0);
			}

			// Expanded view: rich layout with Container + Markdown
			if (expanded && hasAnswer) {
				const container = new Container();

				// Header
				const successCount = details.results.filter((r) => r.status === "success" || r.status === "archived").length;
				const icon = allFailed ? theme.fg("error", "✗") : theme.fg("success", "✓");
				container.addChild(
					new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold("repo_query"))} ${theme.fg("accent", `${successCount}/${details.results.length}`)}`,
						0,
						0,
					),
				);
				container.addChild(new Spacer(1));

				// Query
				container.addChild(new Text(theme.fg("muted", "Query:"), 0, 0));
				container.addChild(new Text(theme.fg("dim", details.query), 0, 0));
				container.addChild(new Spacer(1));

				// Workspace
				if (details.workspacePath) {
					container.addChild(new Text(theme.fg("muted", "Workspace:"), 0, 0));
					container.addChild(new Text(theme.fg("dim", details.workspacePath), 0, 0));
					container.addChild(new Spacer(1));
				}

				// Repositories
				container.addChild(new Text(theme.fg("muted", "Repositories:"), 0, 0));
				for (const r of details.results) {
					const rIcon =
						r.status === "success"
							? theme.fg("success", "✓")
							: r.status === "archived"
								? theme.fg("warning", "⚠")
								: theme.fg("error", "✗");
					let line = `  ${rIcon} ${theme.fg("accent", r.identifier)}`;
					if (r.localPath) line += theme.fg("dim", ` → ${r.localPath}`);
					container.addChild(new Text(line, 0, 0));
					if (r.warnings.length > 0) {
						container.addChild(new Text(`    ${theme.fg("warning", r.warnings[0])}`, 0, 0));
					}
					if (r.error) {
						container.addChild(new Text(`    ${theme.fg("error", r.error)}`, 0, 0));
					}
					if (r.suggestions && r.suggestions.length > 0) {
						container.addChild(new Text(`    ${theme.fg("dim", `Did you mean: ${r.suggestions.join(", ")}?`)}`, 0, 0));
					}
				}
				container.addChild(new Spacer(1));

				// Answer as Markdown
				const answer = details.results.find((r) => r.answer)?.answer;
				if (answer) {
					container.addChild(new Text(theme.fg("muted", "Answer:"), 0, 0));
					container.addChild(new Markdown(answer.trim(), 0, 0, mdTheme));
				}

				return container;
			}

			// Collapsed view
			const successCount = details.results.filter((r) => r.status === "success" || r.status === "archived").length;
			const icon = allFailed ? theme.fg("error", "✗") : theme.fg("success", "✓");
			let text = `${icon} ${theme.fg("toolTitle", theme.bold("repo_query"))} ${theme.fg("accent", `${successCount}/${details.results.length}`)}`;

			for (const r of details.results.slice(0, 3)) {
				const rIcon =
					r.status === "success"
						? theme.fg("success", "✓")
						: r.status === "archived"
							? theme.fg("warning", "⚠")
							: theme.fg("error", "✗");
				text += `\n${rIcon} ${theme.fg("accent", r.identifier)}`;
				if (r.warnings.length > 0) {
					text += ` ${theme.fg("warning", r.warnings[0].substring(0, 40))}`;
					if (r.warnings[0].length > 40) text += theme.fg("dim", "...");
				}
				if (r.error) {
					text += `\n  ${theme.fg("error", r.error.substring(0, 60))}`;
					if (r.error.length > 60) text += theme.fg("dim", "...");
				}
			}
			if (details.results.length > 3) {
				text += `\n${theme.fg("muted", `... +${details.results.length - 3} more`)}`;
			}

			if (hasAnswer) {
				text += `\n${theme.fg("dim", "(Ctrl+O to expand)")}`;
			}

			return new Text(text, 0, 0);
		},
	});
}

function formatOutput(results: RepoResult[], query: string): string {
	const lines: string[] = [];

	const successes = results.filter((r) => r.status === "success" || r.status === "archived");
	const failures = results.filter(
		(r) =>
			r.status === "not_found" ||
			r.status === "clone_failed" ||
			r.status === "exploration_failed" ||
			r.status === "skipped",
	);

	if (successes.length > 0 && successes[0]?.answer) {
		lines.push(`# Answer: ${query}`);
		lines.push("");
		lines.push(successes[0].answer);
	}

	if (failures.length > 0) {
		if (successes.length > 0) lines.push("");
		lines.push("## Issues");
		for (const f of failures) {
			lines.push(`- **${f.identifier}**: ${f.status}`);
			if (f.error) lines.push(`  - ${f.error}`);
			if (f.suggestions && f.suggestions.length > 0) {
				lines.push(`  - Did you mean: ${f.suggestions.join(", ")}?`);
			}
		}
	}

	if (successes.some((r) => r.warnings.length > 0)) {
		lines.push("");
		lines.push("## Warnings");
		for (const s of successes) {
			for (const w of s.warnings) {
				lines.push(`- **${s.identifier}**: ${w}`);
			}
		}
	}

	return lines.join("\n") || "No results.";
}
