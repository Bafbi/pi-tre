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
 * `phase` as progress, `warning` and `error` as notifications.
 */
export type StatusEvent =
	| { kind: "phase"; code: string }
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

/** The subagent backend. Only a host with a text generator supplies it. */
export interface SubagentPort {
	run: RunSubagent;
}

/**
 * Every port a host can supply. A factory takes the intersection of the ports
 * it uses, so this is the union, not a minimum.
 */
export type HostPorts = JjPort &
	WorkspacePort &
	ConfigPort &
	VersionsPort &
	StatusPort;

/** An action: its ports are bound, its input is the only parameter. */
export type Action<Input, Result> = (input: Input) => Promise<Result>;
