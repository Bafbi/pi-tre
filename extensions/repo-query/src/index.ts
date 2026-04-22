import { rm } from "node:fs/promises";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionAPI, truncateHead } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { ensureRepoCloned } from "./clone.js";
import { runExplorer } from "./explorer.js";
import { validateGitHubRepo } from "./github.js";
import { parseRepoIdentifier } from "./resolver.js";
import type { RepoQueryDetails, RepoResult } from "./types.js";
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
			const workspace = await getWorkspacePath(ctx);
			activeWorkspaces.add(workspace);

			const results: RepoResult[] = [];
			const reposToExplore: Array<{ parsed: ReturnType<typeof parseRepoIdentifier>; dirName: string }> = [];

			// ── Phase 1: Parse and validate ─────────────────────────────
			for (const raw of params.repos) {
				let parsed: ReturnType<typeof parseRepoIdentifier>;
				try {
					parsed = parseRepoIdentifier(raw);
				} catch (err) {
					results.push({
						identifier: raw,
						status: "skipped",
						warnings: [],
						error: `Cannot parse identifier: ${err instanceof Error ? err.message : String(err)}`,
					});
					continue;
				}

				// GitHub-specific validation
				if (parsed.host === "github" && parsed.owner && parsed.repo) {
					try {
						const validation = await validateGitHubRepo(parsed.owner, parsed.repo);
						if (!validation.valid) {
							results.push({
								identifier: raw,
								status: "not_found",
								cloneUrl: parsed.cloneUrl,
								warnings: [],
								suggestions: validation.suggestions,
								error: `Repository '${parsed.displayName}' not found on GitHub.`,
							});
							continue;
						}
						if (validation.warning) {
							// Continue but mark warning — will be shown in results
							results.push({
								identifier: raw,
								status: "archived",
								cloneUrl: parsed.cloneUrl,
								warnings: [validation.warning],
							});
							// Still add to explore list
						}
					} catch (err) {
						// GitHub API failure — don't block, proceed with clone attempt
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
			}

			// ── Phase 2: Clone ──────────────────────────────────────────
			for (const { parsed } of reposToExplore) {
				// Check if already have a result (e.g., archived warning)
				const existing = results.find((r) => r.identifier === parsed.raw);
				if (existing && existing.status === "not_found") continue;

				const cloneResult = await ensureRepoCloned(parsed, workspace, signal, pi);

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
				} else if (!existing) {
					results.push({
						identifier: parsed.raw,
						status: "success",
						cloneUrl: parsed.cloneUrl,
						localPath: `${workspace}/${parsed.dirName}`,
						warnings: [],
					});
				}
			}

			// ── Phase 3: Explore ────────────────────────────────────────
			const readyRepos = reposToExplore.filter(({ parsed }) => {
				const result = results.find((r) => r.identifier === parsed.raw);
				return result && (result.status === "success" || result.status === "archived");
			});

			if (readyRepos.length === 0) {
				const errorParts = results.filter((r) => r.error).map((r) => `- ${r.identifier}: ${r.error}`);

				const suggestionParts = results
					.filter((r) => r.suggestions && r.suggestions.length > 0)
					.map((r) => `- ${r.identifier}: did you mean ${r.suggestions?.join(", ")}?`);

				const text = ["No repositories could be explored.", ...errorParts, ...suggestionParts].join("\n");

				return {
					content: [{ type: "text", text }],
					details: { query: params.query, workspacePath: workspace, results } as RepoQueryDetails,
					isError: true,
				};
			}

			// Stream progress
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Exploring ${readyRepos.length} repo(s): ${readyRepos.map((r) => r.parsed.displayName).join(", ")}...`,
					},
				],
				details: { query: params.query, workspacePath: workspace, results } as RepoQueryDetails,
			});

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
					onUpdate?.({
						content: partial.content,
						details: { query: params.query, workspacePath: workspace, results } as RepoQueryDetails,
					});
				},
			});

			if (exploration.error) {
				for (const r of results) {
					if (r.status === "success" || r.status === "archived") {
						r.status = "exploration_failed";
						r.error = exploration.error;
					}
				}
			} else {
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

			return {
				content: [{ type: "text", text: truncation.content }],
				details: { query: params.query, workspacePath: workspace, results } as RepoQueryDetails,
				isError: hasErrors && readyRepos.length === 0,
			};
		},

		renderCall(args, theme, _context) {
			const repos = args.repos.join(", ");
			const preview = args.query.length > 50 ? `${args.query.slice(0, 50)}...` : args.query;
			let text = theme.fg("toolTitle", theme.bold("repo_query "));
			text += theme.fg("accent", `[${args.repos.length} repo(s)]`);
			text += `\n  ${theme.fg("muted", "repos:")} ${theme.fg("dim", repos)}`;
			text += `\n  ${theme.fg("muted", "query:")} ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as RepoQueryDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			let text = theme.fg("toolTitle", theme.bold("repo_query "));
			text += theme.fg("accent", `${details.results.length} repo(s)`);

			for (const r of details.results) {
				const icon =
					r.status === "success"
						? theme.fg("success", "✓")
						: r.status === "archived"
							? theme.fg("warning", "⚠")
							: theme.fg("error", "✗");
				text += `\n${icon} ${theme.fg("accent", r.identifier)}`;
				if (r.warnings.length > 0) {
					text += ` ${theme.fg("warning", r.warnings[0])}`;
				}
				if (r.error) {
					text += `\n  ${theme.fg("error", r.error)}`;
				}
				if (r.suggestions && r.suggestions.length > 0) {
					text += `\n  ${theme.fg("dim", `Did you mean: ${r.suggestions.join(", ")}?`)}`;
				}
			}

			if (expanded) {
				const answer = details.results.find((r) => r.answer)?.answer;
				if (answer) {
					text += `\n\n${theme.fg("muted", "─── Answer ───")}`;
					// Show first few lines
					const lines = answer.split("\n").slice(0, 20);
					for (const line of lines) {
						text += `\n${theme.fg("toolOutput", line)}`;
					}
					if (answer.split("\n").length > 20) {
						text += `\n${theme.fg("dim", "... (truncated)")}`;
					}
				}
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
