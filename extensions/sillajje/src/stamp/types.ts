/**
 * Shared types for the stamp module.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { SillajjeConfig } from "../config.js";
import type { MetadataFieldToggles, ProvenanceVersions } from "../metadata.js";
import type { SpawnFn } from "../sub-generator.js";
import type { ExecFn } from "../workspace.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input for the Session stamp operation. */
export interface SessionStampInput {
	/**
	 * The pending interaction's transcript (pi's own Message[]). With a
	 * transcript the header and trace generate from interaction + diff;
	 * without one the message generates from the diff alone.
	 */
	interaction?: Message[];
	/** Session workspace info: the stamped session's key and its workspace. */
	workspace: { sessionKey: string; wsPath: string };
}

/** Input for the Rev stamp operation (diff-only describe, no seal). */
export interface RevStampInput {
	/** Absolute path of the jj working directory to run jj in. */
	wsPath: string;
	/** Any revset jj resolves: change ID, commit prefix, bookmark, `@`. */
	rev: string;
}

/** Versions the adapter reads once at activation, for the provenance block. */
export type StampEnv = ProvenanceVersions;

/** Dependencies injected into the stamp module. */
export interface StampDeps {
	/** jj execution adapter (existing seam from the workspace module). */
	exec: ExecFn;
	/** Sub-generator backend adapter (existing seam). */
	spawn: SpawnFn;
	/** Fully-populated sillajje config. The module extracts its own options. */
	config: SillajjeConfig;
	/** pi and sillajje versions, rendered into the provenance metadata block. */
	env: StampEnv;
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
			code: string;
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
