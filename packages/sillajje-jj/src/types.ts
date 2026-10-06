/**
 * The typed jj surface.
 *
 * Reads return parsed data and throw a `JjError` on failure; `apply` and
 * `transaction` return a `Result` because their failures are part of the
 * caller's control flow (rollback, re-describe, fold). No caller builds argv.
 */

import type { ExecOptions } from "./exec.js";
import type { JjVersion, VersionCheck } from "./versions.js";

// ---------------------------------------------------------------------------
// Domain data
// ---------------------------------------------------------------------------

export interface Commit {
	commitId: string;
	changeId: string;
	parents: string[];
	description: string;
}

export interface Bookmark {
	name: string;
	target: string[];
	/** Set on a remote-tracking bookmark; absent on a local one. */
	remote?: string;
}

export interface Workspace {
	name: string;
	root: string;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** One write verb. A Mutation is data; the boundary builds the command line. */
export type Mutation =
	| { kind: "describe"; rev: string; message: string }
	| { kind: "new"; revs?: string[]; edit?: boolean }
	| { kind: "bookmarkSet"; name: string; rev: string }
	| { kind: "duplicate"; revset: string; destination: string }
	| {
			kind: "squash";
			from: string;
			onto: string;
			message?: string;
			/** Positional jj filesets restricting which changes move. */
			filesets?: readonly string[];
			/** Keep a source jj would otherwise abandon once it empties. */
			keepEmptied?: boolean;
	  }
	| { kind: "abandon"; revset: string }
	| { kind: "rebase"; source: string; onto: string[] };

export interface MutationResult {
	/** The operation the mutation produced (or the base when it was a no-op). */
	op: string;
	/** Commits the mutation introduced (`new`, `duplicate`); empty otherwise. */
	created: Commit[];
}

// ---------------------------------------------------------------------------
// Failures and results
// ---------------------------------------------------------------------------

/** A rollback that itself failed. Best-effort; never masks the primary failure. */
export interface RollbackFailure {
	op: string;
	exitCode: number;
	stderr: string;
}

export type JjFailure =
	| {
			kind: "command";
			mutation: Mutation;
			exitCode: number;
			stderr: string;
			rollback?: RollbackFailure;
	  }
	| {
			kind: "op-id";
			mutation: Mutation;
			output: string;
			rollback?: RollbackFailure;
	  }
	| { kind: "integrate"; op: string; exitCode: number; stderr: string }
	| {
			kind: "query";
			argv: string[];
			exitCode: number;
			stderr: string;
			rollback?: RollbackFailure;
	  }
	| { kind: "decode"; what: string; raw: string };

export type Result<T> =
	| { ok: true; value: T }
	| { ok: false; error: JjFailure };

/** Read options for a tree diff. `filesets` restrict the diff to those paths. */
interface DiffOptions extends ExecOptions {
	filesets?: readonly string[];
}

/**
 * Which tree a diff reads: one revision against its parent, or the delta of
 * two arbitrary trees. The range form tolerates gaps a merge creates.
 */
export type DiffSpec =
	| { rev: string }
	| { from: string; to: string; filesets?: readonly string[] };

/** A changed path's status. jj's sigil letters map one-to-one. */
export type DiffStatus =
	| "added"
	| "modified"
	| "removed"
	| "renamed"
	| "copied";

/** One changed path, with the line-change count `jj diff --stat` reports. */
export interface DiffFile {
	/**
	 * The target path, usable as an exact fileset. A rename's display form is
	 * `{old => new}`; this is `new`.
	 */
	path: string;
	status: DiffStatus;
	/** Added plus removed lines; `0` for a binary file. */
	changes: number;
}

// ---------------------------------------------------------------------------
// The facade
// ---------------------------------------------------------------------------

/** The transaction handle. The write vocabulary matches `Jj.apply`; `conflicts` reads the chain's current deferred state. */
export type Tx = Pick<Jj, "apply"> & {
	/** Conflicted paths in `revset` at the transaction's current deferred op. */
	conflicts(revset?: string): Promise<string[]>;
};

export interface Jj {
	log(revset: string, options?: ExecOptions): Promise<Commit[]>;
	diff(revset: string, options?: DiffOptions): Promise<string>;
	/** Tree diff between two revisions. Tolerates gaps a merge creates. */
	diffRange(from: string, to: string, options?: DiffOptions): Promise<string>;
	/** Per-file status and line counts. Two reads, zipped by order. */
	diffFiles(spec: DiffSpec, options?: ExecOptions): Promise<DiffFile[]>;
	conflicts(revset?: string, options?: ExecOptions): Promise<string[]>;
	bookmarks(options?: ExecOptions): Promise<Bookmark[]>;
	workspaces(options?: ExecOptions): Promise<Workspace[]>;
	version(options?: ExecOptions): Promise<JjVersion>;
	checkVersion(options?: ExecOptions): Promise<VersionCheck>;

	apply(m: Mutation, options?: ExecOptions): Promise<Result<MutationResult>>;
	transaction<T>(
		recipe: (tx: Tx) => Promise<T>,
		options?: ExecOptions,
	): Promise<Result<T>>;

	/** Push one bookmark to a named remote, or jj's default when omitted. */
	gitPush(
		input: { bookmark: string; remote?: string },
		options?: ExecOptions,
	): Promise<void>;

	workspaceAdd(
		input: { name: string; revision: string; path: string },
		options?: ExecOptions,
	): Promise<Workspace>;
	workspaceForget(name: string, options?: ExecOptions): Promise<void>;
	workspaceUpdateStale(options?: ExecOptions): Promise<void>;
}
