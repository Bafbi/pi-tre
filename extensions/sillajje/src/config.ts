/**
 * Configuration loader for sillajje.
 *
 * Reads from `.pi/configs/sillajje.json` (project-local) with a fallback
 * to `~/.pi/configs/sillajje.json` (global). The project-local config is
 * authoritative — if it exists, its values win entirely over the global file.
 *
 * The config schema is defined via TypeBox, which provides:
 * - A TypeScript type derived from the schema (`SillajjeConfig`)
 * - Runtime validation via `Check()` with descriptive error messages
 * - Default-value application via `Default()`
 * - Unknown-property stripping via `Clean()`
 * - JSON Schema generation for IDE intellisense and tooling
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

import { type Static, Type } from "@sinclair/typebox";
import { Check, Clean, Default } from "@sinclair/typebox/value";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const workspacesRootDefault = `${homedir()}/.pi/sillajje`;

/**
 * JSON Schema for sillajje configuration files.
 *
 * All fields are optional — missing fields are filled by `Default()` with
 * their declared defaults. Unknown properties are stripped by `Clean()`
 * at load time.
 */
export const SillajjeConfigSchema = Type.Object(
	{
		/** JSON Schema reference for IDE intellisense (ignored at runtime). */
		$schema: Type.Optional(Type.String()),
		/** Whether debug logging is enabled. */
		debug: Type.Optional(Type.Boolean({ default: false })),
		/**
		 * Root directory for sillajje workspaces.
		 * Each session gets a workspace at `<workspacesRoot>/<repo-slug>/<session-id>/`.
		 */
		workspacesRoot: Type.Optional(
			Type.String({ default: workspacesRootDefault }),
		),
		/**
		 * Model identifier for the sub-generator (headless pi process that
		 * generates commit subject + summary).
		 */
		subGeneratorModel: Type.Optional(
			Type.String({ default: "openai/gpt-4o-mini" }),
		),
		/**
		 * Shell commands to run sequentially after workspace creation.
		 * Override via `SILLAJJE_POST_INIT` environment variable (semicolon-separated).
		 */
		postInit: Type.Optional(Type.Array(Type.String(), { default: [] })),
	},
	{ additionalProperties: false },
);

/** Runtime type derived from the TypeBox schema. */
export type SillajjeConfig = Static<typeof SillajjeConfigSchema>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Fully-populated default config, derived by applying the schema's defaults
 * to an empty object. Used as the fallback when no config file is found.
 */
const DEFAULTS: SillajjeConfig = Default(
	SillajjeConfigSchema,
	{},
) as SillajjeConfig;

// ---------------------------------------------------------------------------
// Config file paths
// ---------------------------------------------------------------------------

const GLOBAL_CONFIG_PATH = join(homedir(), ".pi/configs/sillajje.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a JSON config file, validate against the schema, and return a fully
 * populated config object (defaults applied, unknown properties stripped).
 *
 * Returns `undefined` when the file doesn't exist, can't be parsed, or
 * fails schema validation. Callers fall back to `DEFAULTS` in these cases.
 */
function readConfigFile(path: string): SillajjeConfig | undefined {
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;

		// Strip unknown properties via additionalProperties: false.
		const cleaned = Clean(SillajjeConfigSchema, parsed);

		if (!Check(SillajjeConfigSchema, cleaned)) {
			console.error(
				`[sillajje] Config validation error in ${path}: expected valid types`,
			);
			return undefined;
		}

		// Apply defaults for missing optional fields.
		return Default(SillajjeConfigSchema, cleaned) as SillajjeConfig;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse `SILLAJJE_POST_INIT` env var into a post-init command array.
 * Splits on `;`, trims whitespace from each entry, and filters empty entries.
 * Returns `undefined` when the env var is not set.
 */
function parsePostInitEnv(): string[] | undefined {
	const raw = process.env["SILLAJJE_POST_INIT"];
	if (raw === undefined || raw === "") return undefined;
	return raw
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Load the sillajje configuration.
 *
 * Resolution order:
 * 1. Project-local `.pi/configs/sillajje.json` (relative to `repoRoot`).
 *    If this file exists, its values are authoritative — the global config
 *    is not consulted.
 * 2. Global `~/.pi/configs/sillajje.json`.
 * 3. Hardcoded defaults (if neither config file exists).
 * 4. `SILLAJJE_POST_INIT` environment variable overrides `postInit` (only).
 *
 * Returns a fully-populated `SillajjeConfig` with all fields set.
 */
export function loadSillajjeConfig(repoRoot?: string): SillajjeConfig {
	let config: SillajjeConfig;

	// Project-local config takes precedence.
	if (repoRoot) {
		const localPath = join(repoRoot, ".pi/configs/sillajje.json");
		const local = readConfigFile(localPath);
		if (local !== undefined) {
			config = local;
		} else {
			// No project config — fall back to global.
			const global = readConfigFile(GLOBAL_CONFIG_PATH);
			config = global ?? { ...DEFAULTS };
		}
	} else {
		// Fall back to global config.
		const global = readConfigFile(GLOBAL_CONFIG_PATH);
		config = global ?? { ...DEFAULTS };
	}

	// Env var overrides postInit from file config.
	const envPostInit = parsePostInitEnv();
	if (envPostInit !== undefined) {
		config.postInit = envPostInit;
	}

	return config;
}
