/**
 * Configuration loader for sillajje.
 *
 * Reads from `.pi/configs/sillajje.json` (project-local) with a fallback
 * to `~/.pi/configs/sillajje.json` (global). The project-local config is
 * authoritative — if it exists, its values win entirely over the global file.
 *
 * Interface: `loadSillajjeConfig(repoRoot?) → SillajjeConfig`
 *
 * This is a deep module: a large amount of config-resolving behaviour
 * (file walking, priority rules, default application, typed parsing) behind
 * a single-function interface. Callers never touch config files directly.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SillajjeConfig {
	/** Whether debug logging is enabled. */
	debug: boolean;
	/**
	 * Root directory for sillajje workspaces.
	 * Each session gets a workspace at `<workspacesRoot>/<repo-slug>/<session-id>/`.
	 * Default: `~/.pi/sillajje`.
	 */
	workspacesRoot: string;
	/**
	 * Model identifier for the sub-generator (headless pi process that
	 * generates commit subject + summary). Used in issue 05.
	 * Default: `"openai/gpt-4o-mini"`.
	 */
	subGeneratorModel: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const HOME = homedir();

const DEFAULTS: SillajjeConfig = {
	debug: false,
	workspacesRoot: `${HOME}/.pi/sillajje`,
	subGeneratorModel: "openai/gpt-4o-mini",
};

// ---------------------------------------------------------------------------
// Config file paths
// ---------------------------------------------------------------------------

const GLOBAL_CONFIG_PATH = join(HOME, ".pi/configs/sillajje.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a JSON config file and return a partial config object.
 * Returns `undefined` when the file doesn't exist or can't be parsed.
 */
function readConfigFile(
	configPath: string,
): Partial<SillajjeConfig> | undefined {
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return parsed as Partial<SillajjeConfig>;
	} catch {
		return undefined;
	}
}

/**
 * Apply partial config values over the defaults, keeping defaults for
 * any keys not present in the partial.
 */
function applyDefaults(
	partial: Partial<SillajjeConfig> | undefined,
): SillajjeConfig {
	if (!partial) return { ...DEFAULTS };
	return {
		// Only `true` enables debug — anything else (false, undefined, null,
		// a non-boolean value) is treated as disabled.
		debug: partial.debug === true,
		workspacesRoot: partial.workspacesRoot ?? DEFAULTS.workspacesRoot,
		subGeneratorModel:
			partial.subGeneratorModel ?? DEFAULTS.subGeneratorModel,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the sillajje configuration.
 *
 * Resolution order:
 * 1. Project-local `.pi/configs/sillajje.json` (relative to `repoRoot`).
 *    If this file exists, its values are authoritative — the global config
 *    is not consulted.
 * 2. Global `~/.pi/configs/sillajje.json`.
 * 3. Hardcoded defaults (if neither config file exists).
 *
 * Returns a fully-populated `SillajjeConfig` with all fields set.
 */
export function loadSillajjeConfig(repoRoot?: string): SillajjeConfig {
	// Project-local config takes precedence.
	if (repoRoot) {
		const localPath = join(repoRoot, ".pi/configs/sillajje.json");
		const local = readConfigFile(localPath);
		if (local !== undefined) {
			return applyDefaults(local);
		}
	}

	// Fall back to global config.
	const global = readConfigFile(GLOBAL_CONFIG_PATH);
	return applyDefaults(global);
}
