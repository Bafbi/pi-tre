import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadExtensionConfig } from "@pi-tre/pi-config";
import { type Static, Type } from "typebox";

/**
 * The OpenCode Console hosted search endpoint. Each successful search costs
 * the workspace USD 0.01, so only an explicit `enabled` turns it on.
 */
const DEFAULT_ENDPOINT = "https://opencode.ai/console/api/websearch";

/** The pi provider whose stored credential the Console accepts. */
const DEFAULT_CREDENTIAL_PROVIDER = "opencode-go";

export const WebSearchConfigSchema = Type.Object(
	{
		/** JSON Schema reference for IDE intellisense (ignored at runtime). */
		$schema: Type.Optional(Type.String()),
		/**
		 * Turn the tool on. Every successful search is billed to the OpenCode
		 * workspace balance at USD 0.01, so the default is off.
		 */
		enabled: Type.Optional(Type.Boolean({ default: false })),
		/** Results kept per search. Extra results from the Console are dropped. */
		maxResults: Type.Optional(
			Type.Number({ default: 8, minimum: 1, maximum: 20 }),
		),
		/** Request timeout. The Console answers well inside 25 s. */
		timeoutMs: Type.Optional(
			Type.Number({ default: 25000, minimum: 1000, maximum: 120000 }),
		),
		/** pi provider whose API key authorizes the Console call. */
		credentialProvider: Type.Optional(
			Type.String({ default: DEFAULT_CREDENTIAL_PROVIDER }),
		),
		/** Console endpoint. Override only for a different Console host. */
		endpoint: Type.Optional(Type.String({ default: DEFAULT_ENDPOINT })),
	},
	{
		additionalProperties: false,
	},
);

type SchemaShape = Static<typeof WebSearchConfigSchema>;

/**
 * The resolved configuration.
 *
 * Every key except `$schema` carries a schema default, and the loader applies
 * `Default()` after merging, so the resolved object always holds a value. The
 * mapped type states that instead of leaving every field optional.
 */
export type WebSearchConfig = {
	[K in Exclude<keyof SchemaShape, "$schema">]-?: Exclude<
		SchemaShape[K],
		undefined
	>;
};

/**
 * The two files the loader reads.
 *
 * The loader builds these paths itself, so this helper exists for the refusal
 * text and for a test that pins the two against drift.
 */
export function webSearchConfigPaths(
	cwd: string,
	configDir?: string | undefined,
): { global: string; project: string } {
	return {
		global: join(
			configDir ?? join(getAgentDir(), "configs"),
			"web-search.json",
		),
		project: join(cwd, CONFIG_DIR_NAME, "configs", "web-search.json"),
	};
}

export interface LoadWebSearchConfigOptions {
	/** Working directory. The project config lives at `<cwd>/.pi/configs/web-search.json`. */
	cwd: string;
	/** Whether the project is trusted. Untrusted projects read the global layer only. */
	trusted?: boolean | undefined;
	/** Override the global config directory. Tests pass a temp dir. */
	configDir?: string | undefined;
}

/**
 * Load web-search configuration through the shared loader.
 *
 * Order: the global layer, then the project layer when `trusted`. The project
 * wins per leaf. An absent file resolves to `enabled: false`, so the tool
 * spends nothing until the user asks for it. See
 * `docs/adr/0002-extension-config-layout.md`.
 */
export function loadWebSearchConfig(
	options: LoadWebSearchConfigOptions,
): WebSearchConfig {
	const loaded = loadExtensionConfig({
		name: "web-search",
		schema: WebSearchConfigSchema,
		repoRoot: options.cwd,
		trusted: options.trusted,
		configDir: options.configDir,
	});
	// The loader applies Default() after merging, so every key that carries a
	// schema default is present. A config test pins that shape.
	return loaded as WebSearchConfig;
}
