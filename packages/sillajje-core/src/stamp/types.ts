/**
 * The stamp action's public types.
 *
 * The adapter derives `InteractionData` from its transcript and passes it in;
 * the core never sees pi's `Message[]`. A Session stamp carries a session
 * `target` that resolves through the `Workspaces` port. A Rev stamp carries
 * the working directory (`cwd`) the adapter already resolved — it is bound to
 * a revision, not a session.
 */

import type { Jj } from "@pi-tre/sillajje-jj";
import type { CurrentSession, Workspaces } from "@pi-tre/sillajje-workspace";
import type {
	Action,
	ProvenanceVersions,
	RunSubagent,
	StatusEvent,
} from "../action.js";
import type { SessionFailure } from "../args.js";
import type { NarrativeDetail } from "../config.js";
import type {
	InteractionRange,
	LoopField,
	StampBodySection,
} from "../metadata.js";

// ---------------------------------------------------------------------------
// Input data
// ---------------------------------------------------------------------------

/** Interaction data derived from a host transcript by the adapter. */
export interface InteractionData {
	prompt: string;
	response: string;
	toolNames: string[];
	toolCallCount: number;
	thinkingBlocks: number;
	elapsedMs: number;
	/**
	 * The Interaction's session entry range, when the host records one. It
	 * renders in `Meta:` so a change maps back to the session log.
	 */
	range?: InteractionRange | undefined;
}

/** Input for the Session stamp: the full seal at a session's working copy. */
export interface SessionStampInput {
	/**
	 * The session to stamp: a session key, a session id, or `@` for the
	 * current session. Resolves through the `Workspaces` port.
	 */
	target: string;
	/** The caller's live session, for the current-session exemption. */
	current?: CurrentSession;
	/**
	 * The pending interaction's derived data. With it the header and trace
	 * generate from interaction + diff; without it the message generates from
	 * the diff alone.
	 */
	interaction?: InteractionData;
}

/** Input for the Rev stamp: describe one revision, nothing else. */
export interface RevStampInput {
	/** Any revset jj resolves: change ID, commit prefix, bookmark, `@`. */
	rev: string;
	/**
	 * The working directory to run jj in. The adapter resolves it (the active
	 * session's workspace, or the repo root when there is no live session);
	 * the core never resolves a session for this action.
	 */
	cwd: string;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type { SessionFailure };

/** The terminal result of a stamp operation. */
export type StampResult =
	| { ok: true; subject: string; rev: string }
	| { ok: false; reason: "no-changes" | "failed" | SessionFailure };

/** The two stamp actions, bound at the factory. */
export interface StampActions {
	session: Action<SessionStampInput, StampResult>;
	rev: Action<RevStampInput, StampResult>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Extracted stamp configuration. */
export interface StampConfig {
	/** The ordered body sections the stamp contributes. */
	body: readonly StampBodySection[];
	headerMode: "one_line" | "user_prompt";
	traceDetail: NarrativeDetail;
	loopFields: readonly LoopField[];
	maxAttempts: number;
	timeoutMs: number;
	model: string;
}

/** The ports a stamp path binds, with the extracted config. */
export interface StampDeps {
	jj: Jj;
	workspaces: Workspaces;
	run: RunSubagent;
	env: ProvenanceVersions;
	onStatus: (event: StatusEvent) => void;
	cfg: StampConfig;
}
