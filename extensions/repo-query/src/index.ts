import { rm } from "node:fs/promises";

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	type CloneImpl,
	clearInFlightClones,
	ensureRepoCloned,
} from "./clone.js";
import { loadRepoQueryConfig, resolveModel } from "./config.js";
import {
	addDebugEvent,
	createDebugState,
	registerDebugCommand,
	setTempspacePath,
	trackRepo,
} from "./debug.js";
import {
	branchHasDelegateMarker,
	delegateToolBlock,
} from "./delegate-guard.js";
import { type ExplorerImpl, runExplorer } from "./explorer.js";
import { parseFindings } from "./findings.js";
import { validateGitHubRepo } from "./github.js";
import {
	formatOutput,
	formatRepoDisplayName,
	formatRetrySuggestions,
	truncateOutput,
} from "./output.js";
import { renderCall, renderResult } from "./render.js";
import { parseRepoIdentifier, redactCredentials } from "./resolver.js";
import {
	buildStructured,
	RepoQueryOutputSchema,
	resolveStatus,
} from "./structured.js";
import { canUseT3Delegate, runT3Delegate } from "./t3-delegate.js";
import { clearTempspaceCache, getTempspacePath } from "./tempspace.js";
import type {
	RepoFinding,
	RepoQueryDetails,
	RepoQueryPhase,
	RepoResult,
	SubagentUsage,
	ValidationResult,
} from "./types.js";
import { isSuccess } from "./types.js";

const MAX_REPOS = 5;

const RepoQueryParams = Type.Object({
	query: Type.String({
		description:
			"One concrete question about the repos' code. Name the symbols, files, or behavior to find so the subagent can grep for them.",
	}),
	repos: Type.Array(
		Type.String({
			description:
				"Repository identifiers: 'owner/repo', 'owner/repo:branch', 'https://github.com/org/repo', or 'git@gitlab.com:org/repo.git'. Add ':branch' to pin a branch.",
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
	/** Replaces runT3Delegate for pipeline-level fallback tests. */
	delegate?: typeof runT3Delegate;
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
			totalFromProvider: usage.costFromProvider === true,
		},
	};
}

/** Create the repo-query extension factory, with optional test overrides. */
export function createRepoQueryExtension(
	overrides: RepoQueryOverrides = {},
): ExtensionFactory {
	return function repoQueryExtension(pi: ExtensionAPI) {
		// Track active temp directories for emergency cleanup
		const activeTempspaces = new Set<string>();
		const debug = createDebugState();
		const validationCache = new Map<string, ValidationResult>();
		/** True once this session's branch shows a repo_query delegate task. */
		let isDelegateSession = false;

		pi.on("session_start", async (_event, ctx) => {
			debug.events.length = 0;
			debug.trackedRepos.clear();
			debug.tempspacePath = null;
			validationCache.clear();
			isDelegateSession = false;
			addDebugEvent(debug, "session_start: state reset", ctx);
		});

		pi.on("session_shutdown", async () => {
			clearTempspaceCache();
			const clearedClones = clearInFlightClones();
			if (clearedClones > 0) {
				addDebugEvent(
					debug,
					`session_shutdown: cleared ${clearedClones} in-flight clone(s)`,
				);
			}
			validationCache.clear();
			for (const ws of activeTempspaces) {
				try {
					await rm(ws, { recursive: true, force: true });
				} catch {
					/* ignore cleanup errors */
				}
			}
			activeTempspaces.clear();
		});

		// A delegate task carries a marker in its prompt. Once the branch shows
		// it, this session may read but not write. pi applies the same hook to
		// nested calls from a codemode script, so tools.write, tools.edit, and
		// tools.bash are blocked inside codemode too.
		pi.on("tool_call", async (event, ctx) => {
			if (!isDelegateSession) {
				isDelegateSession = branchHasDelegateMarker(
					ctx.sessionManager.getBranch(),
				);
			}
			if (!isDelegateSession) return;
			return delegateToolBlock(event.toolName);
		});

		registerDebugCommand(pi, debug);

		pi.registerTool({
			name: "repo_query",
			label: "Repo Query",
			description: [
				"Explore one or more git repositories to answer a query.",
				"Use it for any library, tool, package, or product whose source lives in a git repo, from quick lookups to broad codebase exploration.",
				"Shallow-clones each repo, then a subagent answers using grep, find, and read.",
				"Supports GitHub shorthand ('owner/repo'), full URLs, and branch suffix (:branch).",
				"GitHub repos are validated via API; non-existent repos return search suggestions.",
				"Pass several repos in one call to compare them or to use a docs repo with its code repo. For the same question across unrelated repos, use one call per repo.",
			].join(" "),
			promptSnippet:
				"Query git repositories by cloning them and exploring with a subagent",
			promptGuidelines: [
				"Use repo_query to investigate code in external repositories: implementation details, APIs, patterns, or file locations.",
				"Give repo_query one concrete question per call. Name the symbols, files, or behavior to find so the subagent can grep for them.",
				"repo_query caches clones per session, so follow-up queries on the same repos are cheap.",
				"Pass several repos in one call to compare them or to use them together, such as a docs repo beside its code repo. For the same question across unrelated repos, call repo_query once per repository and combine the results with Promise.allSettled.",
				"Check repo_query's structuredContent.status and repos[].status. A failed exploration sets isError: true and keeps the per-repo errors.",
			],
			parameters: RepoQueryParams,
			outputSchema: RepoQueryOutputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				addDebugEvent(
					debug,
					`execute: query="${params.query.substring(0, 60)}..." repos=[${params.repos.map(redactCredentials).join(", ")}]`,
					ctx,
				);

				const config = loadRepoQueryConfig({
					cwd: ctx.cwd,
					trusted: ctx.isProjectTrusted(),
				});

				// A T3 delegate is a broader agent than the child process, so it
				// is opt-in. The default keeps the process allowlist.
				const explorerMode = config.explorer ?? "process";
				const delegateAvailable = canUseT3Delegate(ctx);
				// Factory overrides win so tests stay deterministic.
				const useT3Delegate =
					explorerMode === "auto" &&
					delegateAvailable &&
					(overrides.delegate !== undefined ||
						overrides.explorer === undefined);
				const tempspace = await getTempspacePath(ctx);
				activeTempspaces.add(tempspace);
				setTempspacePath(debug, tempspace);
				addDebugEvent(debug, `tempspace: ${tempspace}`, ctx);

				let resolvedModel: string | undefined;
				let answer = "";
				let findings: RepoFinding[] = [];
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
							return useT3Delegate
								? `Delegating ${names}${rest} to a T3 subagent...`
								: `Searching ${names}${rest} for "${params.query}"...`;
						case "complete":
							return `Done exploring ${names}${rest}.`;
					}
				};

				const makeDetails = (
					phase: RepoQueryPhase,
					thoughtOverride?: string,
				): RepoQueryDetails => ({
					query: params.query,
					tempspacePath: tempspace,
					results: [...results],
					phase,
					answer,
					findings: [...findings],
					thought: thoughtOverride ?? buildThought(phase),
					model: resolvedModel,
					usage,
				});

				const emitPhase = (phase: RepoQueryPhase) => {
					// Content stays non-empty so hosts that render partial text
					// (RPC clients such as T3 Code) show the phase. The TUI reads
					// `details` instead.
					onUpdate?.({
						content: [{ type: "text", text: buildThought(phase) }],
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
						tempspace,
						signal,
						pi,
						overrides.clone,
					);
					addDebugEvent(
						debug,
						`clone result: ${parsed.raw} → ${cloneResult.status}${cloneResult.status === "failed" ? ` (${cloneResult.error})` : ""}`,
						ctx,
					);

					if (cloneResult.status === "failed") {
						// Update or add result
						if (existing) {
							existing.status = "clone_failed";
							existing.error = cloneResult.error;
							existing.suggestedBranches =
								cloneResult.suggestions;
						} else {
							results.push({
								identifier: parsed.raw,
								status: "clone_failed",
								warnings: [],
								error: cloneResult.error,
								suggestedBranches: cloneResult.suggestions,
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
							localPath: `${tempspace}/${parsed.dirName}`,
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
						existing.localPath = `${tempspace}/${parsed.dirName}`;
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
						"explore: no ready repos, returning a failed result",
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

					// Return the failure instead of throwing: a returned result
					// keeps `details` and `structuredContent` for the TUI and for
					// code-mode scripts. Scripts resolve on isError only when the
					// tool declares an outputSchema and returns structuredContent.
					const details = makeDetails("complete");
					addDebugEvent(
						debug,
						`execute failed: no repos explored (${results.length})`,
						ctx,
					);
					return {
						content: [{ type: "text", text: parts.join("\n") }],
						details,
						structuredContent: buildStructured(
							details,
							"failed",
							false,
						),
						isError: true,
					};
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
					useT3Delegate
						? `t3 delegate start: ${readyRepos.length} repo(s)`
						: `subagent spawn: ${readyRepos.length} repo(s)`,
					ctx,
				);

				const explorationRequest = {
					tempspace,
					repos: readyRepos.map((r) => r.parsed),
					query: params.query,
					model: resolvedModel,
					signal,
				};

				const runProcessExplorer = () =>
					runExplorer(
						{
							...explorationRequest,
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
										partial.details as Record<
											string,
											unknown
										>
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

				let exploration = useT3Delegate
					? await (overrides.delegate ?? runT3Delegate)(
							explorationRequest,
							ctx,
						)
					: await runProcessExplorer();

				if (useT3Delegate && exploration.error) {
					// A delegate can fail because T3 rejected full access, the
					// child asked for approval, or the child ended without an
					// answer. The process backend still answers.
					addDebugEvent(
						debug,
						`t3 delegate failed (${exploration.error.substring(0, 80)}), falling back to child pi`,
						ctx,
					);
					exploration = await runProcessExplorer();
				}

				const explorationFailed = Boolean(exploration.error);

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

				// The subagent ends with a findings block. Parse it, verify
				// each path against the clone, and strip it from the prose so
				// the model does not read the same claims twice.
				if (answer.trim().length > 0) {
					const parsed = await parseFindings(
						answer,
						readyRepos.map((r) => r.parsed),
						tempspace,
					);
					answer = parsed.text;
					findings = parsed.findings;
					addDebugEvent(
						debug,
						`findings: ${findings.length} parsed, ${findings.filter((f) => f.verified).length} verified`,
						ctx,
					);
				}

				// ── Phase 4: Synthesize output ──────────────────────────────
				const details = makeDetails("complete");
				const status = resolveStatus(details, explorationFailed);
				const structured = buildStructured(
					details,
					status,
					exploration.complete ?? !explorationFailed,
				);
				const outputText = formatOutput(details);
				const text = truncateOutput(outputText);

				addDebugEvent(
					debug,
					`execute complete: status=${status} answer=${Boolean(answer)} usage=${usage ? `${usage.totalTokens} tokens` : "none"}`,
					ctx,
				);

				return {
					content: [{ type: "text", text }],
					details,
					structuredContent: structured,
					...(status === "failed" ? { isError: true } : {}),
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
