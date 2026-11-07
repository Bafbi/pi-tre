import type { SubagentUsage } from "@pi-tre/pi-subagent";

/**
 * Shared types for repo-query extension.
 */

export interface ParsedRepo {
	raw: string;
	host: "github" | "gitlab" | "bitbucket" | "generic";
	cloneUrl: string;
	branch: string | null;
	displayName: string;
	dirName: string;
	owner?: string | undefined;
	repo?: string | undefined;
}

export type RepoStatus =
	| "success"
	| "not_found"
	| "archived"
	| "clone_failed"
	| "exploration_failed"
	| "skipped";

/** True for statuses that count as successes in output and rendering. */
export function isSuccess(status: RepoStatus): boolean {
	return status === "success" || status === "archived";
}

/** True for statuses that count as failures in output and rendering. */
export function isFailure(status: RepoStatus): boolean {
	return (
		status === "not_found" ||
		status === "clone_failed" ||
		status === "exploration_failed" ||
		status === "skipped"
	);
}

/**
 * One claim the exploration attributed to a file.
 *
 * `repo` is the repository display name when the model named one.
 * `verified` is true when the path exists inside the clone and, when a line
 * is given, the line is within the file.
 */
export interface RepoFinding {
	repo: string | null;
	path: string;
	line: number | null;
	claim: string;
	verified: boolean;
}

export interface RepoResult {
	identifier: string;
	status: RepoStatus;
	localPath?: string | undefined;
	warnings: string[];
	/** Similar repository names suggested by the GitHub API. */
	suggestions?: string[] | undefined;
	/** Similar branch names suggested after a failed branch clone. */
	suggestedBranches?: string[] | undefined;
	error?: string | undefined;
}

/** Overall outcome of one repo_query call. */
export type RepoQueryStatus = "ok" | "partial" | "failed";

export type RepoQueryPhase =
	| "parsing"
	| "validating"
	| "cloning"
	| "exploring"
	| "complete";

/** Token/cost usage accumulated across a subagent run. */
export type { SubagentUsage } from "@pi-tre/pi-subagent";

export interface RepoQueryDetails {
	query: string;
	tempspacePath: string;
	results: RepoResult[];
	phase: RepoQueryPhase;
	/** The single answer produced by the subagent (absent until exploration completes). */
	answer?: string | undefined;
	/** Claims parsed from the answer and checked against the clones. */
	findings?: RepoFinding[] | undefined;
	thought?: string | undefined;
	model?: string | undefined;
	usage?: SubagentUsage | undefined;
}

export interface ValidationResult {
	valid: boolean;
	warning?: string | undefined;
	suggestions?: string[] | undefined;
}
