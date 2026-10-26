/**
 * The action contract.
 *
 * An action binds its ports at a factory and returns a plain function. The
 * port record is the capability surface: a host that cannot supply a port
 * cannot build the action that needs it. `HostPorts` is what every host has;
 * `SubagentPort` is the text-generator backend only some hosts have.
 */

import type { Jj } from "@pi-tre/sillajje-jj";
import type { Workspaces } from "@pi-tre/sillajje-workspace";
import type { SillajjeConfig } from "./config.js";

/** The pi and sillajje versions the adapter reads once at activation. */
export interface ProvenanceVersions {
	piVersion: string;
	sillajjeVersion: string;
	/** The host's jj version, when the adapter could read it. */
	jjVersion?: string;
}

/**
 * A status event streamed during an action's execution. The adapter renders
 * `plan` and `phase` as progress, `warning` and `error` as notifications.
 */
export type PhaseCode =
	| "collecting-diff"
	| "generating-header"
	| "checking"
	| "sealing-change"
	| "rebasing"
	| "folding"
	| "pushing"
	| "archiving"
	| "unarchiving"
	| "resolving-source";

/**
 * The ordered steps an action will run, announced once before the first
 * phase. The adapter draws the whole list as pending, so a slow step is never
 * the first thing the user sees. A step's target is unknown until its phase
 * arrives, so a planned step carries the code alone.
 */
export type PlanEvent = {
	kind: "plan";
	codes: readonly PhaseCode[];
};

export type StatusEvent =
	| PlanEvent
	| { kind: "phase"; code: PhaseCode; target?: string }
	| { kind: "info"; code: string; message: string }
	| { kind: "warning"; code: string; message: string }
	| { kind: "error"; code: string; message: string };

/** A request to the subagent backend. */
export interface SubagentRequest {
	/** The rendered prompt. */
	prompt: string;
	/** Model identifier. */
	model: string;
	/** Timeout in milliseconds. */
	timeoutMs?: number;
}

/** The subagent backend's answer. */
export interface SubagentResponse {
	/** The final assistant text. */
	text: string;
}

/**
 * The subagent backend port: a prompt in, the final assistant text out.
 * Rejects on timeout, abort, or a failed run, so callers see one failure
 * channel.
 */
export type RunSubagent = (
	request: SubagentRequest,
) => Promise<SubagentResponse>;

/** The typed jj facade. */
export interface JjPort {
	jj: Jj;
}

/** Workspace lifecycle and session targeting. */
export interface WorkspacePort {
	workspaces: Workspaces;
}

/** The fully-populated sillajje config. */
export interface ConfigPort {
	config: SillajjeConfig;
}

/** The pi and sillajje versions the adapter reads once at activation. */
interface VersionsPort {
	versions: ProvenanceVersions;
}

/** The status sink. Treated as infallible by the core. */
export interface StatusPort {
	onStatus: (event: StatusEvent) => void;
}

/**
 * Emit a status through a sink. A throwing sink is caught: it must never
 * corrupt the action.
 */
export function emitStatus(
	onStatus: (event: StatusEvent) => void,
	event: StatusEvent,
): void {
	try {
		onStatus(event);
	} catch {
		// A throwing sink must never corrupt the action.
	}
}

/**
 * Announce the steps an action will run. Call it once, right before the work
 * starts and after input validation, so a rejected input shows no plan.
 *
 * Every phase the action later emits must name a planned step, in the plan's
 * order. The converse does not hold: a planned step may be skipped when a
 * condition resolves false after the plan is announced, and the renderer marks
 * that step skipped.
 */
export function emitPlan(
	onStatus: (event: StatusEvent) => void,
	codes: readonly PhaseCode[],
): void {
	emitStatus(onStatus, { kind: "plan", codes });
}

/** The subagent backend. Only a host with a text generator supplies it. */
export interface SubagentPort {
	run: RunSubagent;
}

/** One shell command the gate asks the host to run. */
export interface CommandRequest {
	/** A shell command line, run with `sh -c` by the host. */
	command: string;
	/** The working directory: the session workspace root. */
	cwd: string;
	/** The per-check timeout. */
	timeoutMs: number;
	/** The turn's abort signal; Escape cancels the check. */
	signal?: AbortSignal | undefined;
}

/** What one command run observed. */
export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
	/** Whether the host killed the process, as on a timeout or abort. */
	killed: boolean;
	/** Wall time as measured by the host. */
	durationMs: number;
}

/**
 * The command boundary. The core never learns how the host spawns a process;
 * the adapter binds this to its own process execution and owns `sh -c`, the
 * environment, and `CI=1`.
 */
export interface CommandPort {
	/** Named `exec`, not `run`: `SubagentPort` already owns `run`, and a Fold
	 * binds both. */
	exec: (input: CommandRequest) => Promise<CommandResult>;
}

/**
 * Every port a host can supply. A factory takes the intersection of the ports
 * it uses, so this is the union, not a minimum.
 */
export type HostPorts = JjPort &
	WorkspacePort &
	ConfigPort &
	VersionsPort &
	StatusPort & {
		/** Present when the host can run a declared check. */
		command: CommandPort;
	};

/** An action: its ports are bound, its input is the only parameter. */
export type Action<Input, Result> = (input: Input) => Promise<Result>;
