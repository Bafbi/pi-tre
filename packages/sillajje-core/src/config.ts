/**
 * Sillajje configuration schema.
 *
 * The core owns the schema: its shape, its defaults, and its validation. The
 * adapter loads the file through `@pi-tre/pi-config` and owns only the
 * `SILLAJJE_POST_INIT` override.
 *
 * The config is action-scoped: `actions.<action>` selects the ordered body
 * sections an action contributes and the detail for each. Generator
 * settings (`subGenerator`, `subGeneratorModel`) stay global — every
 * body-producing action drives the same generators.
 */

import { homedir } from "node:os";

import { type Static, Type } from "@sinclair/typebox";
import { Default } from "@sinclair/typebox/value";

// ---------------------------------------------------------------------------
// Body-section vocabulary
//
// The schema names every section an Action can contribute, so the vocabulary
// lives here and `metadata.ts` re-exports it. Keeping this module free of
// relative imports lets `scripts/generate-schema.ts` load it under Node's
// type stripping.
// ---------------------------------------------------------------------------

/** A `Loop:` field. The action renders the selected fields in this order. */
export type LoopField = "tools" | "call_count" | "elapsed" | "thinking_blocks";

/** Every field a `Loop:` section can render, in default order. */
export const LOOP_FIELDS: readonly LoopField[] = [
	"tools",
	"call_count",
	"elapsed",
	"thinking_blocks",
];

/** A stamp's body section, in config order. */
export type StampBodySection =
	| "trace"
	| "meta"
	| "loop"
	| "prompt"
	| "response";

/** Every section a stamp body can carry, in default order. */
export const STAMP_BODY_SECTIONS: readonly StampBodySection[] = [
	"trace",
	"meta",
	"loop",
	"prompt",
	"response",
];

/** A fold's body section, in config order. */
export type FoldBodySection = "summary" | "ref";

/** Every section a fold body can carry, in default order. */
export const FOLD_BODY_SECTIONS: readonly FoldBodySection[] = [
	"summary",
	"ref",
];

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const workspacesRootDefault = `${homedir()}/.pi/sillajje`;

/** Detail level for a generated narrative (trace or fold summary). */
const NarrativeDetailSchema = Type.Union(
	[Type.Literal("high"), Type.Literal("step"), Type.Literal("decision")],
	{ default: "high" },
);

/** The detail levels every narrative generator accepts. */
export type NarrativeDetail = Static<typeof NarrativeDetailSchema>;

/** How the header sub-generator builds the subject line. */
const HeaderModeSchema = Type.Union(
	[Type.Literal("one_line"), Type.Literal("user_prompt")],
	{ default: "one_line" },
);

/** A stamp body section, in config order. */
const StampBodySectionSchema = Type.Union(
	STAMP_BODY_SECTIONS.map((section) => Type.Literal(section)),
);

/** A fold body section, in config order. */
const FoldBodySectionSchema = Type.Union(
	FOLD_BODY_SECTIONS.map((section) => Type.Literal(section)),
);

/** A `Loop:` field, in config order. */
const LoopFieldSchema = Type.Union(
	LOOP_FIELDS.map((field) => Type.Literal(field)),
);

/** `actions.stamp.header` — how the subject line is generated. */
const HeaderSchema = Type.Object(
	{ mode: Type.Optional(HeaderModeSchema) },
	{ default: {} },
);

/** `actions.<action>.trace` / `.summary` — the generated narrative. */
const NarrativeSchema = Type.Object(
	{ detail: Type.Optional(NarrativeDetailSchema) },
	{ default: {} },
);

/**
 * `actions.stamp` — the stamp's ordered body and section detail. Presence
 * in `body` selects a section; there is no separate `enabled` flag.
 */
const StampActionSchema = Type.Object(
	{
		body: Type.Optional(
			Type.Array(StampBodySectionSchema, {
				default: [...STAMP_BODY_SECTIONS],
				uniqueItems: true,
			}),
		),
		header: Type.Optional(HeaderSchema),
		trace: Type.Optional(NarrativeSchema),
		loop: Type.Optional(
			Type.Array(LoopFieldSchema, {
				default: [...LOOP_FIELDS],
				uniqueItems: true,
			}),
		),
	},
	{ default: {}, additionalProperties: false },
);

/** `actions.fold` — the fold's ordered body and summary detail. */
const FoldActionSchema = Type.Object(
	{
		body: Type.Optional(
			Type.Array(FoldBodySectionSchema, {
				default: [...FOLD_BODY_SECTIONS],
				uniqueItems: true,
			}),
		),
		summary: Type.Optional(NarrativeSchema),
	},
	{ default: {}, additionalProperties: false },
);

/** `actions` — per-action body and section configuration. */
const ActionsSchema = Type.Object(
	{
		stamp: Type.Optional(StampActionSchema),
		fold: Type.Optional(FoldActionSchema),
	},
	{ default: {}, additionalProperties: false },
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
 * All fields are optional. Missing fields are filled by `Default()` with
 * their declared defaults; unknown properties are stripped by `Clean()`.
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
		 * Model identifier for the sub-generator (tool-less pi subagent that
		 * generates commit subject + narrative).
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
		 * Per-action body and section configuration.
		 */
		actions: Type.Optional(ActionsSchema),
		/**
		 * Sub-generator behaviour control.
		 * Controls retry count and timeout.
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
// Defaults and extraction
// ---------------------------------------------------------------------------

/**
 * Fully-populated defaults, derived by applying the schema's defaults to an
 * empty object. Used when no config file is found.
 */
const DEFAULTS: SillajjeConfig = Default(
	SillajjeConfigSchema,
	{},
) as SillajjeConfig;

/** A fresh, fully-populated default config. */
export function defaultSillajjeConfig(): SillajjeConfig {
	return structuredClone(DEFAULTS);
}

/**
 * The generator settings every body-producing action reads: global, not
 * per-action. The defaults mirror the schema, so a caller that builds a
 * config by hand still gets a usable generator.
 */
export interface SubGeneratorDefaults {
	model: string;
	maxAttempts: number;
	timeoutMs: number;
}

/** Extract the global sub-generator settings from a fully-populated config. */
export function subGeneratorDefaults(
	cfg: SillajjeConfig,
): SubGeneratorDefaults {
	return {
		model: cfg.subGeneratorModel ?? "openai/gpt-4o-mini",
		maxAttempts: cfg.subGenerator?.retry?.maxAttempts ?? 3,
		timeoutMs: cfg.subGenerator?.timeoutMs ?? 30_000,
	};
}
