import { rm } from "node:fs/promises";

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { type CloneImpl, ensureRepoCloned } from "./clone.js";
import { loadRepoQueryConfig, resolveModel } from "./config.js";
import {
	addDebugEvent,
	createDebugState,
	registerDebugCommand,
	setWorkspacePath,
	trackRepo,
} from "./debug.js";
import { type ExplorerImpl, runExplorer } from "./explorer.js";
import { validateGitHubRepo } from "./github.js";
import {
	formatOutput,
	formatRepoDisplayName,
	formatRetrySuggestions,
	truncateOutput,
} from "./output.js";
import { renderCall, renderResult } from "./render.js";
import { parseRepoIdentifier, redactCredentials } from "./resolver.js";
import type {
	RepoQueryDetails,
	RepoQueryPhase,
	RepoResult,
	SubagentUsage,
	ValidationResult,
} from "./types.js";
import { isSuccess } from "./types.js";
import { clearWorkspaceCache, getWorkspacePath } from "./workspace.js";

const MAX_REPOS = 5;

const RepoQueryParams = Type.Object({
	query: Type.String({
		description:
			"The question or task to answer by exploring the repositories",
	}),
	repos: Type.Array(
		Type.String({
			description:
				"Repository identifiers. Examples: 'owner/repo', 'owner/repo:branch', 'https://github.com/org/repo', 'git@gitlab.com:org/repo.git'",
		}),
		{ minItems: 1, maxItems: MAX_REPOS },
	),
});

type AgentUsage = NonNullable<AgentToolResult<unknown>["usage"]>;

/**
 * Injection seams for tests. Production callers use the default export, which
 * passes no overrides. Loader-based tests cannot reach factory parameters, so
 * they must use other seams (mocked fetch, mocked pi.exec, local-path repos).
 */
export interface RepoQueryOverrides {
	/** Replaces runExplorer for pipeline-level execute tests. */
	explorer?: ExplorerImpl["run"];
	/** Replaces ensureRepoCloned for pipeline-level execute tests. */
	clone?: CloneImpl;
}

/** Map accumulated subagent usage onto pi's tool-result usage shape. */
function toAgentUsage(usage: SubagentUsage): AgentUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: usage.cost,
		},
	};
}

/** Create the repo-query extension factory, with optional test overrides. */
export function createRepoQueryExtension(
	overrides: RepoQueryOverrides = {},
): ExtensionFactory {
	return function repoQueryExtension(pi: ExtensionAPI) {
		// Track active temp directories for emergency cleanup
		const activeWorkspaces = new Set<string>();
		const debug = createDebugState();
		const validationCache = new Map<string, ValidationResult>();

		pi.on("session_start", async (_event, ctx) => {
			debug.events.length = 0;
			debug.trackedRepos.clear();
			debug.workspacePath = null;
			validationCache.clear();
			addDebugEvent(debug, "session_start: state reset", ctx);
		});

		pi.on("session_shutdown", async () => {
			clearWorkspaceCache();
			validationCache.clear();
			for (const ws of activeWorkspaces) {
				try {
					await rm(ws, { recursive: true, force: true });
				} catch {
					/* ignore cleanup errors */
				}
			}
			activeWorkspaces.clear();
		});

		registerDebugCommand(pi, debug);

		pi.registerTool({
			name: "repo_query",
			label: "Repo Query",
			description: [
				"Explore one or more git repositories to answer a query.",
				"Clones repositories via shallow clone and delegates exploration to a subagent.",
				"Supports GitHub shorthand ('owner/repo'), full URLs, and branch suffix (:branch).",
				"GitHub repos are validated via API; non-existent repos return search suggestions.",
				"Repositories are cached per session and reused across multiple queries.",
			].join(" "),
			promptSnippet:
				"Query git repositories by cloning them and exploring with a subagent",
			promptGuidelines: [
				"Use repo_query when you need to investigate code in external repositories — don't try to read remote code manually.",
				"Provide specific, targeted queries to repo_query; the subagent searches using grep/find/read and fares best with concrete questions about architecture, patterns, or file locations.",
				"repo_query caches cloned repos per session — re-querying the same repo is fast and uses the local copy.",
			],
			parameters: RepoQueryParams,

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				addDebugEvent(
					debug,
					`execute: query="${params.query.substring(0, 60)}..." repos=[${params.repos.map(redactCredentials).join(", ")}]`,
					ctx,
				);

				const config = loadRepoQueryConfig(ctx.cwd);

				const workspace = await getWorkspacePath(ctx);
				activeWorkspaces.add(workspace);
				setWorkspacePath(debug, workspace);
				addDebugEvent(debug, `workspace: ${workspace}`, ctx);

				let resolvedModel: string | undefined;
				let answer = "";
				let usage: SubagentUsage | undefined;
				const results: RepoResult[] = [];
				const reposToExplore: Array<{
					parsed: ReturnType<typeof parseRepoIdentifier>;
					dirName: string;
				}> = [];

				const buildThought = (phase: RepoQueryPhase): string => {
					const names = params.repos
						.slice(0, 2)
						.map((r) => formatRepoDisplayName(r).display)
						.join(", ");
					const rest =
						params.repos.length > 2
							? ` and ${params.repos.length - 2} more`
							: "";
					switch (phase) {
						case "parsing":
							return `Looking up ${names}${rest}...`;
						case "validating":
							return `Checking ${names}${rest}...`;
						case "cloning":
							return `Cloning ${names}${rest} to search for "${params.query}"...`;
						case "exploring":
							return `Searching ${names}${rest} for "${params.query}"...`;
						case "complete":
							return `Done exploring ${names}${rest}.`;
					}
				};

				const makeDetails = (
					phase: RepoQueryPhase,
					thoughtOverride?: string,
				): RepoQueryDetails => ({
					query: params.query,
					workspacePath: workspace,
					results: [...results],
					phase,
					answer,
					thought: thoughtOverride || buildThought(phase),
					model: resolvedModel,
					usage,
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
						addDebugEvent(
							debug,
							`parse failed: ${redactCredentials(raw)} → ${err instanceof Error ? err.message : String(err)}`,
							ctx,
						);
						results.push({
							identifier: redactCredentials(raw),
							status: "skipped",
							warnings: [],
							error: `Cannot parse identifier: ${err instanceof Error ? err.message : String(err)}`,
						});
						emitPhase("parsing");
						continue;
					}

					trackRepo(debug, raw, {
						status: "parsed",
						cloned: false,
						branch: parsed.branch,
					});

					// GitHub-specific validation
					if (
						parsed.host === "github" &&
						parsed.owner &&
						parsed.repo
					) {
						emitPhase("validating");
						let validation: ValidationResult | undefined;
						const cacheKey = `${parsed.owner}/${parsed.repo}`;
						const cached = validationCache.get(cacheKey);
						if (cached) {
							validation = cached;
							addDebugEvent(
								debug,
								`github validate (cached): ${parsed.owner}/${parsed.repo}`,
								ctx,
							);
						} else {
							try {
								addDebugEvent(
									debug,
									`github validate: ${parsed.owner}/${parsed.repo}`,
									ctx,
								);
								validation = await validateGitHubRepo(
									parsed.owner,
									parsed.repo,
								);
								validationCache.set(cacheKey, validation);
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
									warnings: [
										`GitHub API check failed: ${err instanceof Error ? err.message : String(err)}. Proceeding with clone attempt.`,
									],
								});
							}
						}
						if (validation) {
							if (!validation.valid) {
								addDebugEvent(
									debug,
									`github not_found: ${parsed.displayName} suggestions=[${validation.suggestions?.join(", ") ?? ""}]`,
									ctx,
								);
								results.push({
									identifier: raw,
									status: "not_found",
									warnings: [],
									suggestions: validation.suggestions,
									error: `Repository '${parsed.displayName}' not found on GitHub.`,
								});
								trackRepo(debug, raw, {
									status: "not_found",
									cloned: false,
								});
								emitPhase("validating");
								continue;
							}
							if (validation.warning) {
								addDebugEvent(
									debug,
									`github archived: ${parsed.displayName}`,
									ctx,
								);
								results.push({
									identifier: raw,
									status: "archived",
									warnings: [validation.warning],
								});
								trackRepo(debug, raw, {
									status: "archived",
									cloned: false,
								});
								// Still add to explore list
							}
						}
					}

					reposToExplore.push({ parsed, dirName: parsed.dirName });
					emitPhase("validating");
				}

				// ── Phase 2: Clone ──────────────────────────────────────────
				addDebugEvent(
					debug,
					`phase: clone (${reposToExplore.length} repos to clone)`,
					ctx,
				);
				for (const { parsed } of reposToExplore) {
					// Reuse an existing result (e.g. archived warning) instead of adding a duplicate
					const existing = results.find(
						(r) => r.identifier === parsed.raw,
					);

					emitPhase("cloning");
					addDebugEvent(
						debug,
						`clone start: ${parsed.raw} → ${parsed.dirName}`,
						ctx,
					);
					const cloneResult = await ensureRepoCloned(
						parsed,
						workspace,
						signal,
						pi,
						overrides.clone,
					);
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
								warnings: [],
								error: cloneResult.error,
							});
						}
						trackRepo(debug, parsed.raw, {
							status: "clone_failed",
							cloned: false,
						});
					} else if (!existing) {
						results.push({
							identifier: parsed.raw,
							status: "success",
							localPath: `${workspace}/${parsed.dirName}`,
							warnings: [],
						});
						trackRepo(debug, parsed.raw, {
							status: "cloned",
							cloned: true,
							branch: parsed.branch,
						});
					} else {
						if (existing.status !== "archived") {
							existing.status = "success";
						}
						existing.localPath = `${workspace}/${parsed.dirName}`;
						trackRepo(debug, parsed.raw, {
							status: existing.status,
							cloned: true,
							branch: parsed.branch,
						});
					}
					emitPhase("cloning");
				}

				// ── Phase 3: Explore ────────────────────────────────────────
				const readyRepos = reposToExplore.filter(({ parsed }) => {
					const result = results.find(
						(r) => r.identifier === parsed.raw,
					);
					return result && isSuccess(result.status);
				});

				addDebugEvent(
					debug,
					`phase: explore (${readyRepos.length} ready repos)`,
					ctx,
				);

				if (readyRepos.length === 0) {
					addDebugEvent(
						debug,
						"explore: no ready repos, throwing hard failure",
						ctx,
					);

					const errorParts = results
						.filter((r) => r.error)
						.map((r) => `- ${r.identifier}: ${r.error}`);

					const suggestionParts = results
						.filter(
							(r) => r.suggestions && r.suggestions.length > 0,
						)
						.map(
							(r) =>
								`- ${r.identifier}: did you mean ${r.suggestions?.join(", ")}?`,
						);

					const retryLines = formatRetrySuggestions(results);

					const parts: string[] = [
						"No repositories could be explored.",
						...errorParts,
						...suggestionParts,
					];

					if (retryLines.length > 0) {
						parts.push("");
						parts.push(
							"Some repositories were not found. Consider retrying with the suggested names:",
						);
						parts.push(...retryLines);
					}

					// pi's tool contract: throwing reports the failure to the LLM.
					throw new Error(parts.join("\n"));
				}

				resolvedModel = resolveModel(
					config,
					readyRepos.map((r) => r.parsed),
				);
				if (resolvedModel) {
					addDebugEvent(debug, `model: ${resolvedModel}`, ctx);
				}

				emitPhase("exploring");
				addDebugEvent(
					debug,
					`subagent spawn: ${readyRepos.length} repo(s)`,
					ctx,
				);
				const exploration = await runExplorer(
					{
						workspace,
						repos: readyRepos.map((r) => r.parsed),
						query: params.query,
						model: resolvedModel,
						signal,
						onUpdate: (partial) => {
							// Update the streamed answer text
							const text =
								partial.content[0]?.type === "text"
									? partial.content[0].text
									: "";
							if (text && text !== "(exploring...)") {
								answer = text;
							}
							// Stream actual subagent thinking if available
							let subagentThought: string | undefined;
							if (
								partial.details &&
								typeof partial.details === "object" &&
								"thought" in partial.details
							) {
								const raw = (
									partial.details as Record<string, unknown>
								).thought;
								if (
									typeof raw === "string" &&
									raw.trim().length > 0
								) {
									subagentThought = raw;
								}
							}
							onUpdate?.({
								content: partial.content,
								details: makeDetails(
									"exploring",
									subagentThought,
								),
							});
						},
					},
					overrides.explorer
						? { run: overrides.explorer }
						: undefined,
				);

				if (exploration.usage) {
					usage = exploration.usage;
				}

				if (exploration.error) {
					addDebugEvent(
						debug,
						`explore failed: ${exploration.error.substring(0, 120)}`,
						ctx,
					);
					for (const r of results) {
						if (isSuccess(r.status)) {
							r.status = "exploration_failed";
							r.error = exploration.error;
						}
					}
				} else {
					addDebugEvent(
						debug,
						`explore success: answer=${exploration.answer.length} chars`,
						ctx,
					);
					// The subagent produces one answer for the whole query.
					answer = exploration.answer;
				}

				// ── Phase 4: Synthesize output ──────────────────────────────
				const details = makeDetails("complete");
				const outputText = formatOutput(details);
				const text = truncateOutput(outputText);

				addDebugEvent(
					debug,
					`execute complete: answer=${Boolean(answer)} usage=${usage ? `${usage.totalTokens} tokens` : "none"}`,
					ctx,
				);

				return {
					content: [{ type: "text", text }],
					details,
					...(usage ? { usage: toAgentUsage(usage) } : {}),
				};
			},

			renderCall,

			renderResult,
		});
	};
}

export default function (pi: ExtensionAPI): void {
	createRepoQueryExtension()(pi);
}
