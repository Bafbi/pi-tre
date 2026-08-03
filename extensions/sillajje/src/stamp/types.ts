/**
 * Shared types for the stamp module.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { SillajjeConfig } from "../config.js";
import type { MetadataFieldToggles } from "../metadata.js";
import type { SpawnFn } from "../sub-generator.js";
import type { ExecFn } from "../workspace.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input for the stamp operation. */
export interface StampInput {
	/**
	 * Pi's own transcript (Message[] from @earendil-works/pi-ai).
	 * `null` for a Diff stamp (derived from a diff, not an Interaction).
	 */
	interaction: Message[] | null;
	/** Session workspace info. */
	workspace: { sessionKey: string; wsPath: string };
	/**
	 * Revision to target. Default `"@"`.
	 * `"@"` → full seal (update-stale → describe → bookmark set → jj new).
	 * Any other rev → describe-only.
	 */
	rev?: string;
}

/** Dependencies injected into the stamp module. */
export interface StampDeps {
	/** jj execution adapter (existing seam from the workspace module). */
	exec: ExecFn;
	/** Sub-generator subprocess adapter (existing seam). */
	spawn: SpawnFn;
	/** Fully-populated sillajje config. The module extracts its own options. */
	config: SillajjeConfig;
	/**
	 * Status sink — called during execution for phases, warnings, and errors.
	 * Treated as infallible: a throwing sink is caught and never corrupts the stamp.
	 */
	onStatus?: (s: StampStatus) => void;
}

/** A status event emitted during stamp execution. */
export type StampStatus =
	| {
			kind: "phase";
			code: "collecting-diff" | "generating-header" | "sealing-change";
	  }
	| {
			kind: "warning";
			code: "header-fallback" | "trace-fallback";
			message: string;
	  }
	| { kind: "error"; code: string; message: string };

/** The terminal result of a stamp operation. */
export type StampResult =
	| { ok: true; subject: string; rev: string }
	| { ok: false; reason: "no-changes" | "failed" };

// ---------------------------------------------------------------------------
// Internal types (shared across sub-modules)
// ---------------------------------------------------------------------------

/** Extracted stamp configuration (internal). */
export interface StampConfig {
	headerMode: "one_line" | "user_prompt";
	traceEnabled: boolean;
	traceDetail: "high" | "step" | "decision";
	metaFields: MetadataFieldToggles;
	metaEnabled: boolean;
	showUserPrompt: boolean;
	showResponse: boolean;
	maxAttempts: number;
	timeoutMs: number;
	model: string;
}

/** Result of deriving interaction data from a Message[] transcript (internal). */
export interface DerivedInteractionData {
	prompt: string;
	response: string;
	toolNames: string[];
	toolCallCount: number;
	thinkingBlocks: number;
	elapsedMs: number;
}
