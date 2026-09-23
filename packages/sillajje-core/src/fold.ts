/**
 * The fold action.
 *
 * `createFold(ports)` publishes a source range as one clean change: it
 * aggregates the delta between a base and a source tip into a single change
 * placed as a child of a target. The source branch survives.
 *
 * The mechanism, pinned by a real-jj prototype (ADR 0006):
 *
 * 1. Create an empty child of the target — the folded change.
 * 2. Duplicate the delta onto the target.
 * 3. Squash the copies into the empty child, describing it with the generated
 *    body.
 *
 * Steps run inside one deferred transaction, so a failure or a conflict rolls
 * the whole fold back. The body is a generated summary and a `Ref:` line; it
 * carries no `Meta:` and no `Loop:`.
 */

import {
	type Commit,
	formatFailure,
	type Jj,
	type Tx,
} from "@pi-tre/sillajje-jj";
import type { CurrentSession } from "@pi-tre/sillajje-workspace";
import {
	type Action,
	type ConfigPort,
	emitStatus,
	type JjPort,
	type StatusPort,
	type SubagentPort,
	type WorkspacePort,
} from "./action.js";
import type { CommandHelp, CommandSpec, SessionFailure } from "./args.js";
import {
	type NarrativeDetail,
	type SillajjeConfig,
	subGeneratorDefaults,
} from "./config.js";
import {
	buildFoldBody,
	FOLD_BODY_SECTIONS,
	type FoldBodySection,
	smartWrap,
} from "./metadata.js";
import {
	generateHeader,
	generateTrace,
	type SubGeneratorContext,
} from "./sub-generator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The fold input. */
export interface FoldInput {
	/** Session source: a session key, a session id, or `@`. */
	session?: string | undefined;
	/** Rev source: any single revision. Mutually exclusive with `session`. */
	rev?: string | undefined;
	/** The target revision the folded change is placed under. */
	onto: string;
	/** The caller's live session, for the current-session exemption. */
	current?: CurrentSession | undefined;
	/** A working directory for a rev or archived-session source. */
	cwd?: string | undefined;
	/** Advance the single local bookmark `--onto` resolves to. */
	land?: boolean | undefined;
	/** Archive the session after a successful fold (session sources only). */
	archive?: boolean | undefined;
}

/** The fold outcome. Conflicts carry the files for the adapter to render. */
export type FoldResult =
	| {
			ok: true;
			subject: string;
			rev: string;
			ref: string;
			/** The folded session, when the source was one. */
			sessionKey?: string | undefined;
			/** Whether the session was archived after the fold. */
			archived?: boolean | undefined;
	  }
	| {
			ok: false;
			reason:
				| "no-changes"
				| "failed"
				| "conflict"
				| "usage"
				| SessionFailure;
			files?: string[];
			message?: string;
	  };

/** The fold's extracted configuration. */
export interface FoldConfig {
	body: readonly FoldBodySection[];
	summaryDetail: NarrativeDetail;
	model: string;
	maxAttempts: number;
	timeoutMs: number;
}

/** A recipe-detected conflict. Thrown so the transaction rolls back. */
class FoldAbort extends Error {
	constructor(readonly files: string[]) {
		super("fold produced conflicts");
	}
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Extract the fold options from the fully-populated config. */
export function getFoldConfig(cfg: SillajjeConfig): FoldConfig {
	const fold = cfg.actions?.fold;
	const generator = subGeneratorDefaults(cfg);
	return {
		body: fold?.body ?? FOLD_BODY_SECTIONS,
		summaryDetail: fold?.summary?.detail ?? "high",
		...generator,
	};
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

interface FoldSource {
	/** The resolved source tip. */
	tip: Commit;
	/** The folded-source bookmark name, `<name>` in `sillajje/folded/<name>`. */
	name: string;
	/** The session key, when the source is a session. */
	sessionKey?: string;
	/** The directory jj runs in. */
	cwd: string;
}

/** Resolve exactly one revision, or throw a jj error the caller relays. */
async function resolveSingle(
	jj: Jj,
	rev: string,
	cwd: string,
): Promise<Commit> {
	const commits = await jj.log(rev, { cwd });
	if (commits.length !== 1) {
		throw new Error(
			`fold source ${rev} resolves to ${commits.length} revisions — expected one`,
		);
	}
	const commit = commits[0];
	if (commit === undefined) {
		throw new Error(`fold source ${rev} resolves to no revision`);
	}
	return commit;
}

/**
 * The folded-source bookmark name for a rev source: the single local
 * bookmark at the tip, or a slug of the rev string when the rev carries no
 * bookmark. jj bookmark names reject `~`, `^`, `:`, `@`, and spaces, so the
 * fallback strips them.
 */
async function foldedSourceName(
	jj: Jj,
	tip: Commit,
	rev: string,
	cwd: string,
): Promise<string> {
	const locals = (await jj.bookmarks({ cwd })).filter(
		(bookmark) =>
			bookmark.remote === undefined &&
			bookmark.target.includes(tip.commitId),
	);
	const only = locals[0];
	if (locals.length === 1 && only !== undefined) return only.name;
	return slugRev(rev);
}

/** A bookmark-safe token for a rev that names no bookmark. */
function slugRev(rev: string): string {
	const slug = rev
		.trim()
		.replace(/[^A-Za-z0-9._/-]+/g, "-")
		.replace(/^[-/]+|[-/]+$/g, "");
	return slug.length > 0 ? slug : "rev";
}

/** The first and last commit in a duplicated range. */
function copyRange(copies: Commit[]): { root: Commit; head: Commit } {
	const ids = new Set(copies.map((c) => c.commitId));
	const root = copies.find((c) => c.parents.every((p) => !ids.has(p)));
	const head = copies.find(
		(c) => !copies.some((other) => other.parents.includes(c.commitId)),
	);
	if (root === undefined || head === undefined) {
		throw new Error("fold: could not identify the duplicated range");
	}
	return { root, head };
}

// ---------------------------------------------------------------------------
// The action
// ---------------------------------------------------------------------------

/**
 * Bind the fold action's ports and return the action. It needs jj, the
 * workspace port, the config, the status sink, and the sub-generator.
 */ export function createFold(
	ports: JjPort & WorkspacePort & ConfigPort & StatusPort & SubagentPort,
): Action<FoldInput, FoldResult> {
	const { jj, workspaces, onStatus } = ports;
	const cfg = getFoldConfig(ports.config);

	const fail = (message: string): FoldResult => {
		emitStatus(onStatus, {
			kind: "error",
			code: "fold_failed",
			message,
		});
		return { ok: false, reason: "failed" };
	};

	return async (input) => {
		const sessionTarget =
			input.session ?? (input.rev === undefined ? "@" : undefined);
		const cwd = input.cwd ?? ".";

		if (input.archive === true && sessionTarget === undefined) {
			return {
				ok: false,
				reason: "usage",
				message: "--archive requires a session source",
			};
		}

		let source: FoldSource;
		try {
			if (sessionTarget !== undefined) {
				const target =
					sessionTarget === "@"
						? (input.current?.sessionKey ?? sessionTarget)
						: sessionTarget;
				const resolved = await workspaces.resolveTarget(
					target,
					input.current ?? {},
				);
				if (resolved.ok) {
					source = {
						tip: await resolveSingle(jj, "@", resolved.wsPath),
						name: resolved.sessionKey,
						sessionKey: resolved.sessionKey,
						cwd: resolved.wsPath,
					};
				} else if (resolved.reason === "archived") {
					const sessionKey = workspaces.sessionKey(target);
					source = {
						tip: await resolveSingle(
							jj,
							workspaces.bookmarkName(sessionKey),
							cwd,
						),
						name: sessionKey,
						sessionKey,
						cwd,
					};
				} else {
					return { ok: false, reason: resolved.reason };
				}
			} else {
				const rev = input.rev ?? "";
				const tip = await resolveSingle(jj, rev, cwd);
				source = {
					tip,
					name: await foldedSourceName(jj, tip, rev, cwd),
					cwd,
				};
			}
		} catch (err) {
			return fail(`fold source resolution failed: ${String(err)}`);
		}

		const { tip } = source;
		const sourceCwd = source.cwd;
		const foldedBookmark = `sillajje/folded/${source.name}`;

		// The delta base: the recorded folded-source tip, else the fork point.
		let base: Commit;
		let delta: Commit[];
		try {
			const bookmarks = await jj.bookmarks({ cwd: sourceCwd });
			const recorded = bookmarks.find(
				(b) => b.name === foldedBookmark && b.remote === undefined,
			);
			if (recorded !== undefined && recorded.target.length > 0) {
				const recordedTarget = recorded.target[0];
				if (recordedTarget === undefined) {
					return fail(
						`fold could not resolve ${foldedBookmark} to one commit`,
					);
				}
				const recordedCommits = await jj.log(recordedTarget, {
					cwd: sourceCwd,
				});
				if (recordedCommits.length !== 1) {
					return fail(
						`fold could not resolve ${foldedBookmark} to one commit`,
					);
				}
				const recordedCommit = recordedCommits[0];
				if (recordedCommit === undefined) {
					return fail(
						`fold could not resolve ${foldedBookmark} to one commit`,
					);
				}
				base = recordedCommit;
			} else {
				const bases = await jj.log(
					`fork_point(${tip.changeId} | ${input.onto})`,
					{ cwd: sourceCwd },
				);
				if (bases.length !== 1) {
					return fail(
						`fold could not find a single base for ${input.onto}`,
					);
				}
				const baseCommit = bases[0];
				if (baseCommit === undefined) {
					return fail(
						`fold could not find a single base for ${input.onto}`,
					);
				}
				base = baseCommit;
			}
			delta = await jj.log(`${base.changeId}..${tip.changeId}`, {
				cwd: sourceCwd,
			});
		} catch (err) {
			return fail(`fold base resolution failed: ${String(err)}`);
		}

		// An empty delta is a designed no-op, before any mutation.
		if (delta.length === 0) {
			return { ok: false, reason: "no-changes" };
		}

		// `--land` moves exactly one local bookmark pointing at the target.
		let ontoBookmark: string | undefined;
		if (input.land) {
			try {
				const targets = await jj.log(input.onto, { cwd: sourceCwd });
				if (targets.length !== 1) {
					return {
						ok: false,
						reason: "usage",
						message:
							"--land needs --onto to resolve to exactly one revision",
					};
				}
				const target = targets[0];
				if (target === undefined) {
					return {
						ok: false,
						reason: "usage",
						message:
							"--land needs --onto to resolve to exactly one revision",
					};
				}
				const targetCommitId = target.commitId;
				const local = (await jj.bookmarks({ cwd: sourceCwd })).filter(
					(b) =>
						b.remote === undefined &&
						b.target.includes(targetCommitId),
				);
				if (local.length !== 1) {
					return {
						ok: false,
						reason: "usage",
						message: `--land needs --onto to resolve to exactly one local bookmark; ${input.onto} matches ${local.length}`,
					};
				}
				const ontoLocal = local[0];
				if (ontoLocal === undefined) {
					return {
						ok: false,
						reason: "usage",
						message: `--land needs --onto to resolve to exactly one local bookmark; ${input.onto} matches ${local.length}`,
					};
				}
				ontoBookmark = ontoLocal.name;
			} catch (err) {
				return fail(`fold --land resolution failed: ${String(err)}`);
			}
		}

		// Generate the body from the folded change's own diff.
		let body: string;
		let subject: string;
		try {
			const diff = await jj.diff(`${base.commitId}..${tip.commitId}`, {
				cwd: sourceCwd,
			});
			const subCtx: SubGeneratorContext = {
				transcript: "",
				diff,
				previousDescriptions: [],
			};
			const [header, summary] = await Promise.all([
				generateHeader(subCtx, ports.run, {
					model: cfg.model,
					maxAttempts: cfg.maxAttempts,
					timeoutMs: cfg.timeoutMs,
					prompt: "",
				}),
				generateTrace(subCtx, ports.run, {
					model: cfg.model,
					maxAttempts: cfg.maxAttempts,
					timeoutMs: cfg.timeoutMs,
					detail: cfg.summaryDetail,
				}),
			]);
			if (header.fellBack) {
				emitStatus(onStatus, {
					kind: "warning",
					code: "header-fallback",
					message:
						"fold subject generation failed — sub-generator exhausted retries",
				});
			}
			if (summary.fellBack) {
				emitStatus(onStatus, {
					kind: "warning",
					code: "summary-fallback",
					message:
						"fold summary generation failed — sub-generator exhausted retries",
				});
			}
			subject = header.text;
			const ref = `${base.changeId}..${tip.changeId}`;
			body = buildFoldBody(
				{ subject, summary: smartWrap(summary.text, 72), ref },
				cfg.body,
			);
		} catch (err) {
			return fail(`fold message generation failed: ${String(err)}`);
		}

		emitStatus(onStatus, { kind: "phase", code: "folding" });

		// One transaction: empty child → duplicate delta → squash copies.
		const recipe = async (tx: Tx): Promise<Commit | undefined> => {
			const created = await tx.apply({
				kind: "new",
				revs: [input.onto],
				edit: false,
			});
			if (!created.ok) return undefined;
			const folded = created.value.created[0];
			if (folded === undefined) {
				throw new Error("fold: jj new created no commit");
			}

			const duplicated = await tx.apply({
				kind: "duplicate",
				revset: `${base.commitId}..${tip.commitId}`,
				destination: input.onto,
			});
			if (!duplicated.ok) return undefined;
			const { root, head } = copyRange(duplicated.value.created);

			const squashed = await tx.apply({
				kind: "squash",
				from: `${root.changeId}::${head.changeId}`,
				onto: folded.changeId,
				message: body,
			});
			if (!squashed.ok) return undefined;

			// A conflict is an expected abort; throwing rolls the chain back.
			const conflicts = await tx.conflicts(folded.changeId);
			if (conflicts.length > 0) throw new FoldAbort(conflicts);

			// Record the folded source tip for the next fold's delta base.
			const recorded = await tx.apply({
				kind: "bookmarkSet",
				name: foldedBookmark,
				rev: tip.changeId,
			});
			if (!recorded.ok) return undefined;

			if (ontoBookmark !== undefined) {
				const landed = await tx.apply({
					kind: "bookmarkSet",
					name: ontoBookmark,
					rev: folded.changeId,
				});
				if (!landed.ok) return undefined;
			}

			return folded;
		};

		let folded: Commit;
		try {
			const result = await jj.transaction(recipe, { cwd: sourceCwd });
			if (!result.ok) {
				return fail(`fold failed: ${formatFailure(result.error)}`);
			}
			if (result.value === undefined) {
				return fail("fold failed: the transaction did not complete");
			}
			folded = result.value;
		} catch (err) {
			if (err instanceof FoldAbort) {
				emitStatus(onStatus, {
					kind: "warning",
					code: "conflict",
					message: `fold produced file-level conflicts — resolve them manually:\n${err.files.join("\n")}`,
				});
				return { ok: false, reason: "conflict", files: err.files };
			}
			return fail(`fold failed: ${String(err)}`);
		}

		// A successful fold can retire a session source, opt-in. A failed
		// archive is reported but never undoes the fold.
		let archived: boolean | undefined;
		if (input.archive === true && source.sessionKey !== undefined) {
			const outcome = await workspaces.archive(source.sessionKey);
			archived = outcome.status !== "failed";
			if (outcome.status === "failed") {
				emitStatus(onStatus, {
					kind: "warning",
					code: "archive_failed",
					message: `fold succeeded but archiving ${source.sessionKey} failed: ${outcome.reason}`,
				});
			}
		}

		return {
			ok: true,
			subject,
			rev: folded.changeId,
			ref: `${base.changeId}..${tip.changeId}`,
			sessionKey: source.sessionKey,
			archived,
		};
	};
}

/** The fold subcommand — publish a source range under a target. */
export const FOLD_ARGS: CommandSpec = {
	name: "fold",
	usage: "fold (-s <id|@> | -r <rev>) -o <rev>",
	flags: [
		{ key: "session", aliases: ["-s", "--session"], takesValue: true },
		{ key: "rev", aliases: ["-r", "--rev"], takesValue: true },
		{ key: "onto", aliases: ["-o", "--onto"], takesValue: true },
		{ key: "land", aliases: ["--land"], takesValue: false },
		{ key: "archive", aliases: ["--archive"], takesValue: false },
	],
	required: ["onto"],
	exclusive: [["session", "rev"]],
};

/** The fold subcommand's help. */
export const FOLD_HELP: CommandHelp = {
	usage: FOLD_ARGS.usage,
	lines: [
		"Publishes a source range as one clean change under a target.",
		"  -s, --session <id>  fold a session; @ means this session (default)",
		"  -r, --rev <rev>     fold a single revision",
		"  -o, --onto <rev>    the target the folded change is placed under (required)",
		"      --land          advance the target's single local bookmark",
		"      --archive       archive the session after a successful fold",
		"  -h, --help          show this help",
	],
};
