/**
 * Configuration loader for sillajje.
 *
 * Path resolution, reading, parsing, merging, and the trust gate live in
 * `@pi-tre/pi-config`:
 * - Global config: `~/.pi/agent/configs/sillajje.json`
 * - Project config: `<repo-root>/.pi/configs/sillajje.json`, read only when
 *   the project is trusted.
 *
 * The schema is owned by `@pi-tre/sillajje-core`. It supplies the field
 * defaults, so callers always get a fully-populated `SillajjeConfig`. See
 * `docs/adr/0002-extension-config-layout.md`.
 *
 * Interface: `loadSillajjeConfig({ repoRoot?, configDir?, trusted? })
 * → SillajjeConfig`.
 *
 * `SILLAJJE_POST_INIT` is extension policy, not loader policy: it overrides
 * `postInit` from either layer.
 */

import { loadExtensionConfig } from "@pi-tre/pi-config";
import {
	type SillajjeConfig,
	SillajjeConfigSchema,
} from "@pi-tre/sillajje-core";

export type { SillajjeConfig };

/**
 * Parse `SILLAJJE_POST_INIT` into a post-init command array. Splits on `;`,
 * trims each entry, drops empty entries. Returns `undefined` when unset.
 */
function parsePostInitEnv(): string[] | undefined {
	const raw = process.env.SILLAJJE_POST_INIT;
	if (raw === undefined || raw === "") return undefined;
	return raw
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export interface LoadSillajjeConfigOptions {
	/** Project root. Omit to read the global layer only. */
	repoRoot?: string | undefined;
	/**
	 * Whether the project is trusted. Defaults to `false`, so an untrusted
	 * project reads the global layer only. Project config can carry shell
	 * commands (`postInit`), so callers pass `ctx.isProjectTrusted()`.
	 */
	trusted?: boolean | undefined;
	/** Override the global config directory. Tests pass a temp dir. */
	configDir?: string | undefined;
}

/**
 * Load the sillajje configuration through the shared loader.
 *
 * Order: the global layer, then the project layer when `trusted`. The project
 * wins per leaf, arrays replaced. `SILLAJJE_POST_INIT` overrides `postInit`
 * from either layer.
 *
 * Returns a fully-populated `SillajjeConfig` with all fields set.
 */
export function loadSillajjeConfig(
	options: LoadSillajjeConfigOptions = {},
): SillajjeConfig {
	const config = loadExtensionConfig({
		name: "sillajje",
		schema: SillajjeConfigSchema,
		repoRoot: options.repoRoot,
		trusted: options.trusted,
		configDir: options.configDir,
	});

	// Env var overrides postInit from file config.
	const envPostInit = parsePostInitEnv();
	if (envPostInit !== undefined) {
		config.postInit = envPostInit;
	}

	return config;
}
