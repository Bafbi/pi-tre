/**
 * Parent-facing prompt surface for the `repo_query` tool: the description, the
 * one-line prompt snippet, and the guidelines appended to the parent's system
 * prompt.
 *
 * This module has no imports at all, so a node-run benchmark can load the real
 * text directly with type stripping.
 */

/** Tool description lines, joined with a space. */
const DESCRIPTION_LINES = [
	"Explore one or more git repositories to answer a query.",
	"Use it for any library, tool, package, or product whose source lives in a git repo, from quick lookups to broad codebase exploration.",
	"Shallow-clones each repo, then a subagent answers using grep, find, and read.",
	"Supports GitHub shorthand ('owner/repo'), full URLs, and branch suffix (:branch).",
	"GitHub repos are validated via API; non-existent repos return search suggestions.",
	"Pass several repos in one call to compare them or to use a docs repo with its code repo. For the same question across unrelated repos, use one call per repo.",
];

/** The tool description the parent model reads. */
export const REPO_QUERY_DESCRIPTION = DESCRIPTION_LINES.join(" ");

/** The one-line snippet that lists the tool in the parent's prompt. */
export const REPO_QUERY_PROMPT_SNIPPET =
	"Query git repositories by cloning them and exploring with a subagent";

/** Guidelines appended to the parent's system prompt. */
export const REPO_QUERY_PROMPT_GUIDELINES = [
	"Use repo_query to investigate code in external repositories: implementation details, APIs, patterns, or file locations.",
	"Give repo_query one concrete question per call. Name the symbols, files, or behavior to find so the subagent can grep for them.",
	"repo_query caches clones per session, so follow-up queries on the same repos are cheap.",
	"Pass several repos in one call to compare them or to use them together, such as a docs repo beside its code repo. For the same question across unrelated repos, call repo_query once per repository and combine the results with Promise.allSettled.",
	"Check repo_query's structuredContent.status and repos[].status. A failed exploration sets isError: true and keeps the per-repo errors.",
];
