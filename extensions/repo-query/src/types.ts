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

export interface RepoResult {
	identifier: string;
	status: RepoStatus;
	cloneUrl?: string;
	localPath?: string;
	answer?: string;
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

export interface RepoQueryDetails {
	query: string;
	workspacePath: string;
	results: RepoResult[];
	phase: RepoQueryPhase;
	thought?: string;
	model?: string;
}

export interface ValidationResult {
	valid: boolean;
	archived?: boolean;
	warning?: string;
	suggestions?: string[];
}
