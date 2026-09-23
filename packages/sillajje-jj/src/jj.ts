/**
 * `createJj` — assemble the typed facade over one `ExecFn`.
 *
 * The facade owns argv construction, `--at-op` chaining, operation-id parsing,
 * created-commit discovery, and rollback. Callers state typed Mutations and
 * read typed data.
 */

import {
	bookmarksArgv,
	COLOR_FLAG,
	commitIdsAtOpArgv,
	commitsAtOpArgv,
	conflictsArgv,
	diffArgv,
	diffRangeArgv,
	headOperationArgv,
	logArgv,
	mutationArgv,
	NOTHING_CHANGED,
	parsePrintedOpId,
	versionArgv,
	workspacesArgv,
} from "./argv.js";
import { decodeBookmarks, decodeCommits, decodeWorkspaces } from "./decode.js";
import { JjError } from "./errors.js";
import type { ExecFn, ExecOptions, ExecResult } from "./exec.js";
import type {
	Commit,
	Jj,
	JjFailure,
	Mutation,
	MutationResult,
	Result,
	RollbackFailure,
	Tx,
	Workspace,
} from "./types.js";
import {
	checkVersionString,
	type JjVersion,
	parseJjVersion,
	type VersionCheck,
} from "./versions.js";

/** Exit code recorded when the process itself could not be spawned. */
const SPAWN_FAILED = -1;

function mergeOptions(base: ExecOptions, override?: ExecOptions): ExecOptions {
	const merged: ExecOptions = { ...base };
	if (override?.signal !== undefined) merged.signal = override.signal;
	if (override?.timeout !== undefined) merged.timeout = override.timeout;
	if (override?.cwd !== undefined) merged.cwd = override.cwd;
	return merged;
}

function failureOf(error: unknown): JjFailure {
	if (error instanceof JjError) return error.failure;
	throw error;
}

export function createJj(exec: ExecFn, defaults: ExecOptions = {}): Jj {
	const fullArgv = (argv: string[]): string[] => [...argv, COLOR_FLAG];

	const run = (argv: string[], options?: ExecOptions): Promise<ExecResult> =>
		exec("jj", fullArgv(argv), mergeOptions(defaults, options));

	async function queryString(
		argv: string[],
		options?: ExecOptions,
	): Promise<string> {
		const result = await run(argv, options);
		if (result.code !== 0) {
			throw new JjError({
				kind: "query",
				argv: fullArgv(argv),
				exitCode: result.code,
				stderr: result.stderr,
			});
		}
		return result.stdout;
	}

	async function readHeadOperation(options?: ExecOptions): Promise<string> {
		const argv = headOperationArgv();
		const output = await queryString(argv, options);
		const id = output.trim();
		if (!/^[0-9a-f]+$/.test(id)) {
			throw new JjError({
				kind: "decode",
				what: "head operation id",
				raw: output,
			});
		}
		return id;
	}

	async function resolveCommitIds(
		revs: string[],
		op: string,
		options?: ExecOptions,
	): Promise<string[]> {
		const output = await queryString(
			commitIdsAtOpArgv(revs.join(" | "), op),
			options,
		);
		return output
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	}

	/**
	 * The revset a Mutation creates commits in, or `undefined` when it creates
	 * none. `new` names the children of its (resolved) base; `duplicate` names
	 * the descendants of its destination.
	 */
	async function changedInRevset(
		mutation: Mutation,
		baseOp: string,
		options?: ExecOptions,
	): Promise<string | undefined> {
		if (mutation.kind === "new") {
			const revs =
				mutation.revs && mutation.revs.length > 0
					? mutation.revs
					: ["@"];
			const ids = await resolveCommitIds(revs, baseOp, options);
			if (ids.length === 0) return undefined;
			return `children(${ids.join(" | ")})`;
		}
		if (mutation.kind === "duplicate") {
			return `descendants(${mutation.destination})`;
		}
		return undefined;
	}

	/** Commits in the mutation's `changedIn` revset that appear only at `toOp`. */
	async function createdBetween(
		mutation: Mutation,
		fromOp: string,
		toOp: string,
		options?: ExecOptions,
	): Promise<Commit[]> {
		const revset = await changedInRevset(mutation, fromOp, options);
		if (revset === undefined) return [];
		const before = decodeCommits(
			await queryString(commitsAtOpArgv(revset, fromOp), options),
		);
		const after = decodeCommits(
			await queryString(commitsAtOpArgv(revset, toOp), options),
		);
		const beforeIds = new Set(before.map((c) => c.commitId));
		return after.filter((c) => !beforeIds.has(c.commitId));
	}

	// -----------------------------------------------------------------------
	// Integrated apply — one operation, working copy snapshotted by jj
	// -----------------------------------------------------------------------

	async function apply(
		mutation: Mutation,
		options?: ExecOptions,
	): Promise<Result<MutationResult>> {
		const creates =
			mutation.kind === "new" || mutation.kind === "duplicate";
		try {
			const beforeOp = creates
				? await readHeadOperation(options)
				: undefined;
			const result = await run(mutationArgv(mutation), options);
			if (result.code !== 0) {
				return {
					ok: false,
					error: {
						kind: "command",
						mutation,
						exitCode: result.code,
						stderr: result.stderr,
					},
				};
			}
			const op = await readHeadOperation(options);
			const created =
				creates && beforeOp !== undefined
					? await createdBetween(mutation, beforeOp, op, options)
					: [];
			return { ok: true, value: { op, created } };
		} catch (error) {
			return { ok: false, error: failureOf(error) };
		}
	}

	// -----------------------------------------------------------------------
	// Deferred transaction
	// -----------------------------------------------------------------------

	async function transaction<T>(
		recipe: (tx: Tx) => Promise<T>,
		options?: ExecOptions,
	): Promise<Result<T>> {
		let head: string;
		try {
			head = await readHeadOperation(options);
		} catch (error) {
			return { ok: false, error: failureOf(error) };
		}

		const state: {
			prevOp: string;
			firstMinted?: string;
			failure?: JjFailure;
		} = { prevOp: head };

		const rollback = async (): Promise<RollbackFailure | undefined> => {
			if (state.firstMinted === undefined) return undefined;
			const result = await run(
				["op", "abandon", state.firstMinted],
				options,
			);
			if (result.code === 0) return undefined;
			return {
				op: state.firstMinted,
				exitCode: result.code,
				stderr: result.stderr,
			};
		};

		const tx: Tx = {
			conflicts: async (revset) => {
				const argv = [
					...conflictsArgv(revset),
					"--at-op",
					state.prevOp,
					"--ignore-working-copy",
				];
				const output = await queryString(argv, options);
				return output
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line.length > 0);
			},
			apply: async (mutation) => {
				if (state.failure !== undefined) {
					// The chain already failed. A later step is a silent no-op, so a
					// recipe that ignores a step's Result still aborts the whole
					// transaction on the first failure.
					return { ok: false, error: state.failure };
				}
				const baseOp = state.prevOp;
				const argv = [
					...mutationArgv(mutation),
					"--at-op",
					baseOp,
					"--ignore-working-copy",
					"--no-integrate-operation",
				];

				let result: ExecResult;
				try {
					result = await run(argv, options);
				} catch (error) {
					state.failure = {
						kind: "command",
						mutation,
						exitCode: SPAWN_FAILED,
						stderr: String(error),
					};
					return { ok: false, error: state.failure };
				}

				const combined = `${result.stdout}\n${result.stderr}`;
				if (result.code !== 0) {
					state.failure = {
						kind: "command",
						mutation,
						exitCode: result.code,
						stderr: result.stderr,
					};
					return { ok: false, error: state.failure };
				}

				const opId = parsePrintedOpId(combined);
				if (opId === undefined) {
					if (combined.includes(NOTHING_CHANGED)) {
						// jj minted no operation — the step's end state already holds.
						return { ok: true, value: { op: baseOp, created: [] } };
					}
					state.failure = {
						kind: "op-id",
						mutation,
						output: combined.trim(),
					};
					return { ok: false, error: state.failure };
				}

				if (state.firstMinted === undefined) {
					state.firstMinted = opId;
				}

				let created: Commit[] = [];
				try {
					created = await createdBetween(
						mutation,
						baseOp,
						opId,
						options,
					);
				} catch (error) {
					state.failure = failureOf(error);
					return { ok: false, error: state.failure };
				}

				state.prevOp = opId;
				return { ok: true, value: { op: opId, created } };
			},
		};

		let value: T;
		try {
			value = await recipe(tx);
		} catch (error) {
			// A recipe bug is not a jj failure: roll back, then rethrow.
			await rollback();
			throw error;
		}

		if (state.failure !== undefined) {
			const failedRollback = await rollback();
			const failure = state.failure;
			const attachRollback =
				failedRollback !== undefined &&
				(failure.kind === "command" ||
					failure.kind === "op-id" ||
					failure.kind === "query");
			return {
				ok: false,
				error: attachRollback
					? { ...failure, rollback: failedRollback }
					: failure,
			};
		}

		if (state.firstMinted === undefined) {
			// Nothing minted: no integrate, nothing to publish.
			return { ok: true, value };
		}

		const integrate = await run(["op", "integrate", state.prevOp], options);
		if (integrate.code !== 0) {
			// The chain is preserved intentionally: `jj op integrate <id>` is
			// the documented manual recovery.
			return {
				ok: false,
				error: {
					kind: "integrate",
					op: state.prevOp,
					exitCode: integrate.code,
					stderr: integrate.stderr,
				},
			};
		}

		return { ok: true, value };
	}

	// -----------------------------------------------------------------------
	// Version
	// -----------------------------------------------------------------------

	async function version(options?: ExecOptions): Promise<JjVersion> {
		const raw = (await queryString(versionArgv(), options)).trim();
		const parsed = parseJjVersion(raw);
		if (parsed === undefined) {
			throw new JjError({ kind: "decode", what: "jj version", raw });
		}
		return parsed;
	}

	async function checkVersion(options?: ExecOptions): Promise<VersionCheck> {
		const raw = (await queryString(versionArgv(), options)).trim();
		return checkVersionString(raw);
	}

	// -----------------------------------------------------------------------
	// Workspace lifecycle verbs
	// -----------------------------------------------------------------------

	async function workspaceAdd(
		input: { name: string; revision: string; path: string },
		options?: ExecOptions,
	): Promise<Workspace> {
		await queryString(
			[
				"workspace",
				"add",
				"--name",
				input.name,
				"--revision",
				input.revision,
				input.path,
			],
			options,
		);
		const workspaces = await queryString(workspacesArgv(), options);
		const registered = decodeWorkspaces(workspaces).find(
			(workspace) => workspace.name === input.name,
		);
		// jj owns path canonicalisation; prefer its answer over the input path.
		return registered ?? { name: input.name, root: input.path };
	}

	async function workspaceForget(
		name: string,
		options?: ExecOptions,
	): Promise<void> {
		await queryString(["workspace", "forget", name], options);
	}

	async function workspaceUpdateStale(options?: ExecOptions): Promise<void> {
		await queryString(["workspace", "update-stale"], options);
	}

	return {
		log: async (revset, options) =>
			decodeCommits(await queryString(logArgv(revset), options)),
		diff: (revset, options) => queryString(diffArgv(revset), options),
		diffRange: (from, to, options) =>
			queryString(diffRangeArgv(from, to), options),
		conflicts: async (revset, options) => {
			const output = await queryString(conflictsArgv(revset), options);
			return output
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
		},
		bookmarks: async (options) =>
			decodeBookmarks(await queryString(bookmarksArgv(), options)),
		workspaces: async (options) =>
			decodeWorkspaces(await queryString(workspacesArgv(), options)),
		version,
		checkVersion,
		apply,
		transaction,
		workspaceAdd,
		workspaceForget,
		workspaceUpdateStale,
	};
}
