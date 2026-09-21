/**
 * Configuration loader for sillajje.
 *
 * Path resolution, parsing, and merging live in `@pi-tre/pi-config`:
 * - Global config: `~/.pi/agent/configs/sillajje.json`
 * - Project config: `<repo-root>/.pi/configs/sillajje.json`, read only when
 *   the project is trusted.
 *
 * The schema is TypeBox. It supplies the field defaults, so callers always get
 * a fully-populated `SillajjeConfig`. See
 * `docs/adr/0002-extension-config-layout.md`.
 *
 * Interface: `loadSillajjeConfig({ repoRoot?, configDir?, trusted? })
 * → SillajjeConfig`.
 */

import { homedir } from "node:os";
import { loadExtensionConfig } from "@pi-tre/pi-config";
import { type Static, Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const workspacesRootDefault = `${homedir()}/.pi/sillajje`;

/** Detail level for the trace narrative. */
const TraceDetailSchema = Type.Union(
	[Type.Literal("high"), Type.Literal("step"), Type.Literal("decision")],
	{ default: "high" },
);

/** `message.body.trace` — controls the trace section. */
const MessageBodyTraceSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ default: true })),
		detail: Type.Optional(TraceDetailSchema),
	},
	{ default: {} },
);

/** `message.body.meta` — controls the metadata block fields. */
const MessageBodyMetaSchema = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ default: true })),
		tools: Type.Optional(Type.Boolean({ default: true })),
		call_count: Type.Optional(Type.Boolean({ default: true })),
		elapsed: Type.Optional(Type.Boolean({ default: true })),
		thinking_blocks: Type.Optional(Type.Boolean({ default: true })),
	},
	{ default: {} },
);

/** `message.body` — which sections appear in the commit body. */
const MessageBodySchema = Type.Object(
	{
		trace: Type.Optional(MessageBodyTraceSchema),
		meta: Type.Optional(MessageBodyMetaSchema),
		user_prompt: Type.Optional(Type.Boolean({ default: true })),
		response: Type.Optional(Type.Boolean({ default: true })),
	},
	{ default: {} },
);

/** `message` — commit message structure control. */
const MessageSchema = Type.Object(
	{
		header: Type.Optional(
			Type.Union(
				[Type.Literal("one_line"), Type.Literal("user_prompt")],
				{ default: "one_line" },
			),
		),
		body: Type.Optional(MessageBodySchema),
	},
	{ default: {} },
);

/** `subGenerator.retry` — retry configuration. */
const SubGeneratorRetrySchema = Type.Object(
	{
		maxAttempts: Type.Optional(Type.Integer({ default: 3 })),
	},
	{ default: {} },
);

/** `subGenerator` — sub-generator behaviour control. */
const SubGeneratorSchema = Type.Object(
	{
		retry: Type.Optional(SubGeneratorRetrySchema),
		timeoutMs: Type.Optional(Type.Integer({ default: 30_000 })),
	},
	{ default: {} },
);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * JSON Schema for sillajje configuration files.
 *
 * All fields are optional. Missing fields are filled with their declared
 * defaults, and unknown properties are stripped with a warning, both by the
 * shared loader at load time.
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
		/**
		 * Commit message structure control.
		 * Controls how the header is generated and which body sections appear.
		 */
		message: Type.Optional(MessageSchema),
		/**
		 * Sub-generator behaviour control.
		 * Controls retry count, timeout, and other behavioural knobs.
		 */
		subGenerator: Type.Optional(SubGeneratorSchema),
		/**
		 * Whether the workspace block tells the agent to ask before running jj
		 * or git commands. Defaults to `true`: sillajje owns the session's jj
		 * state, and an unrequested VCS command can move bookmarks or rewrite
		 * history.
		 */
		vcsGuard: Type.Optional(Type.Boolean({ default: true })),
	},
	{ additionalProperties: false },
);

/** Runtime type derived from the TypeBox schema. */
export type SillajjeConfig = Static<typeof SillajjeConfigSchema>;

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

export interface LoadSillajjeConfigOptions {
	/** Project root. Omit to read the global layer only. */
	repoRoot?: string;
	/**
	 * Whether the project is trusted. Defaults to `false`, so an untrusted
	 * project reads the global layer only. Project config can carry shell
	 * commands (`postInit`), so callers pass `ctx.isProjectTrusted()`.
	 */
	trusted?: boolean;
	/** Override the global config directory. Tests pass a temp dir. */
	configDir?: string;
}

/**
 * Load the sillajje configuration.
 *
 * Order: the global layer, then the project layer when `trusted`. The project
 * wins per leaf. `SILLAJJE_POST_INIT` overrides `postInit` from either layer.
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
