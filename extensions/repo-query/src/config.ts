import { loadExtensionConfig } from "@pi-tre/pi-config";
import { type Static, Type } from "@sinclair/typebox";

import type { ParsedRepo } from "./types.js";

export const RepoQueryConfigSchema = Type.Object(
	{
		/** JSON Schema reference for IDE intellisense (ignored at runtime). */
		$schema: Type.Optional(Type.String()),
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

export interface LoadRepoQueryConfigOptions {
	/** Working directory. The project config lives at `<cwd>/.pi/configs/repo-query.json`. */
	cwd: string;
	/** Whether the project is trusted. Untrusted projects read the global layer only. */
	trusted?: boolean;
	/** Override the global config directory. Tests pass a temp dir. */
	configDir?: string;
}

/**
 * Load repo-query configuration through the shared loader.
 *
 * Order: the global layer, then the project layer when `trusted`. The project
 * wins per leaf, and the `models` map merges per key. See
 * `docs/adr/0002-extension-config-layout.md`.
 */
export function loadRepoQueryConfig(
	options: LoadRepoQueryConfigOptions,
): RepoQueryConfig {
	return loadExtensionConfig({
		name: "repo-query",
		schema: RepoQueryConfigSchema,
		repoRoot: options.cwd,
		trusted: options.trusted,
		configDir: options.configDir,
	});
}

/**
 * Resolve the model to use for a set of repos.
 *
 * Resolution order:
 * 1. Per-repo config matching the first repo's display name
 * 2. `defaultModel` from config
 * 3. `REPO_QUERY_MODEL` environment variable
 * 4. undefined (subagent uses its own default)
 *
 * For multi-repo queries, only the first repo is checked for a per-repo
 * override. If you need different models for different repos, make separate
 * tool calls.
 */
export function resolveModel(
	config: RepoQueryConfig,
	repos: ParsedRepo[],
): string | undefined {
	if (repos.length > 0) {
		const firstRepo = repos[0];
		if (
			firstRepo &&
			config.models &&
			Object.hasOwn(config.models, firstRepo.displayName)
		) {
			const value = config.models[firstRepo.displayName];
			if (value.length > 0) {
				return value;
			}
		}
	}

	return config.defaultModel ?? process.env.REPO_QUERY_MODEL;
}
