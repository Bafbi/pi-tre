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
	owner?: string;
	repo?: string;
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

export interface RepoResult {
	identifier: string;
	status: RepoStatus;
	localPath?: string;
	warnings: string[];
	suggestions?: string[];
	error?: string;
}

export type RepoQueryPhase =
	| "parsing"
	| "validating"
	| "cloning"
	| "exploring"
	| "complete";

/** Token/cost usage accumulated across the subagent's LLM turns. */
export interface SubagentUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	totalTokens: number;
}

export interface RepoQueryDetails {
	query: string;
	workspacePath: string;
	results: RepoResult[];
	phase: RepoQueryPhase;
	/** The single answer produced by the subagent (absent until exploration completes). */
	answer?: string;
	thought?: string;
	model?: string;
	usage?: SubagentUsage;
}

export interface ValidationResult {
	valid: boolean;
	warning?: string;
	suggestions?: string[];
}
