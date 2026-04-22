import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";

import type { ParsedRepo } from "./types.js";

export const RepoQueryConfigSchema = Type.Object(
	{
		/** Default model for all repo queries. */
		defaultModel: Type.Optional(Type.String()),
		/** Per-repo model overrides. Keys are repo display names like `owner/repo`. */
		models: Type.Optional(Type.Record(Type.String(), Type.String())),
	},
	{
		additionalProperties: false,
	},
);

export type RepoQueryConfig = Static<typeof RepoQueryConfigSchema>;

const DEFAULT_CONFIG: RepoQueryConfig = {};

function loadConfigFile(path: string): RepoQueryConfig {
	if (!existsSync(path)) return {};
	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content) as unknown;
		if (typeof parsed === "object" && parsed !== null) {
			return parsed as RepoQueryConfig;
		}
	} catch {
		/* ignore malformed config */
	}
	return {};
}

/**
 * Load repo-query configuration, merging global and project-local files.
 * Project-local takes precedence.
 */
export function loadRepoQueryConfig(cwd: string): RepoQueryConfig {
	const globalPath = join(getAgentDir(), "extensions", "repo-query.json");
	const projectPath = join(cwd, ".pi", "extensions", "repo-query.json");

	const globalConfig = loadConfigFile(globalPath);
	const projectConfig = loadConfigFile(projectPath);

	return {
		...DEFAULT_CONFIG,
		...globalConfig,
		...projectConfig,
		// Merge nested models maps so project keys override global keys
		models: {
			...globalConfig.models,
			...projectConfig.models,
		},
	};
}

/**
 * Resolve the model to use for a set of repos.
 *
 * Resolution order:
 * 1. Per-repo config matching the first repo's display name
 * 2. `defaultModel` from config
 * 3. undefined (subagent uses its own default)
 *
 * For multi-repo queries, only the first repo is checked for a per-repo
 * override. If you need different models for different repos, make separate
 * tool calls.
 */
export function resolveModel(config: RepoQueryConfig, repos: ParsedRepo[]): string | undefined {
	if (repos.length > 0) {
		const firstRepo = repos[0];
		if (firstRepo && config.models?.[firstRepo.displayName]) {
			return config.models[firstRepo.displayName];
		}
	}

	return config.defaultModel ?? process.env.TEST_MODEL;
}
