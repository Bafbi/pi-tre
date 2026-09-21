/**
 * Shared configuration loader for pi-tre extensions.
 *
 * The contract is recorded in `docs/adr/0002-extension-config-layout.md`:
 * - Global config: `<getAgentDir()>/configs/<extension>.json`
 * - Project config: `<repoRoot>/<CONFIG_DIR_NAME>/configs/<extension>.json`
 *
 * Each layer is parsed on its own. An invalid layer is skipped with a warning,
 * so one bad file cannot wipe the other. Valid layers are deep-merged with the
 * project winning per leaf, then schema defaults are applied. Callers receive a
 * fully-populated object and never touch a config file.
 *
 * Interface: `loadExtensionConfig({ name, schema, repoRoot?, configDir?, trusted? })
 * → Static<schema>`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "@sinclair/typebox";
import { Check, Clean, Default, Value } from "@sinclair/typebox/value";

export interface LoadExtensionConfigOptions<T extends TSchema> {
	/** Extension name. The config file is `<name>.json`. */
	name: string;
	/** TypeBox schema. It also supplies the field defaults. */
	schema: T;
	/** Project root. Omit to read the global layer only. */
	repoRoot?: string;
	/** Override the global config directory. Tests pass a temp dir. */
	configDir?: string;
	/**
	 * Whether the project is trusted. Defaults to `false`, so an untrusted
	 * project reads the global layer only. Project config can carry shell
	 * commands, so callers pass `ctx.isProjectTrusted()`.
	 */
	trusted?: boolean;
}

/**
 * Load and merge an extension's configuration.
 *
 * Order: the global layer, then the project layer when `trusted`. The project
 * layer wins per leaf, and arrays are replaced, not concatenated.
 */
export function loadExtensionConfig<T extends TSchema>(
	options: LoadExtensionConfigOptions<T>,
): Static<T> {
	const { name, schema, repoRoot, configDir, trusted = false } = options;

	const globalPath = join(
		configDir ?? join(getAgentDir(), "configs"),
		`${name}.json`,
	);
	const globalLayer = readLayer(name, schema, globalPath);

	let projectLayer: Record<string, unknown> | undefined;
	if (repoRoot !== undefined && trusted) {
		const projectPath = join(
			repoRoot,
			CONFIG_DIR_NAME,
			"configs",
			`${name}.json`,
		);
		projectLayer = readLayer(name, schema, projectPath);
	}

	const merged = deepMerge(globalLayer ?? {}, projectLayer ?? {});
	return Default(schema, merged) as Static<T>;
}

/**
 * Read one config layer.
 *
 * Returns the cleaned object, or `undefined` when the file is absent, holds
 * invalid JSON, is not a JSON object, or fails schema validation.
 */
function readLayer<T extends TSchema>(
	name: string,
	schema: T,
	path: string,
): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		warn(name, `${path} is not valid JSON: ${errorMessage(err)}`);
		return undefined;
	}

	if (!isPlainObject(parsed)) {
		warn(name, `${path} must contain a JSON object`);
		return undefined;
	}

	// `Clean` mutates its input, so keep a copy to diff against.
	const before = structuredClone(parsed);
	const cleaned = Clean(schema, parsed) as Record<string, unknown>;
	warnUnknownKeys(name, before, cleaned, path);

	if (!Check(schema, cleaned)) {
		const details = [...Value.Errors(schema, cleaned)]
			.map((error) => `${error.path || "/"}: ${error.message}`)
			.join("; ");
		warn(name, `${path} failed validation: ${details}`);
		return undefined;
	}

	return cleaned;
}

/**
 * Warn about keys `Clean` removed, before they disappear. Diffing the cleaned
 * object against the parsed one reports every ignored key, nested included,
 * without depending on error codes or on every nested object declaring
 * `additionalProperties: false`.
 */
function warnUnknownKeys(
	name: string,
	parsed: Record<string, unknown>,
	cleaned: Record<string, unknown>,
	path: string,
): void {
	for (const key of strippedKeys(parsed, cleaned)) {
		warn(name, `${path}: unknown key "${key}" ignored`);
	}
}

/** Keys present in `original` but absent from `cleaned`, as dotted paths. */
function strippedKeys(
	original: Record<string, unknown>,
	cleaned: Record<string, unknown>,
): string[] {
	const keys: string[] = [];
	for (const [key, originalValue] of Object.entries(original)) {
		if (!(key in cleaned)) {
			keys.push(key);
			continue;
		}
		const cleanedValue = cleaned[key];
		if (isPlainObject(originalValue) && isPlainObject(cleanedValue)) {
			for (const nested of strippedKeys(originalValue, cleanedValue)) {
				keys.push(`${key}.${nested}`);
			}
		}
	}
	return keys;
}

/**
 * Deep-merge plain objects. The override wins per leaf. Arrays and scalars are
 * replaced, not concatenated.
 */
function deepMerge(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, overrideValue] of Object.entries(override)) {
		const baseValue = result[key];
		result[key] =
			isPlainObject(baseValue) && isPlainObject(overrideValue)
				? deepMerge(baseValue, overrideValue)
				: overrideValue;
	}
	return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warn(name: string, message: string): void {
	console.error(`[${name}] ${message}`);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
