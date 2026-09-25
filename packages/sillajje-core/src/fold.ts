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
	type Bookmark,
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

/** The fold input. One of `onto` (publish) or `update` (update) is required. */
export interface FoldInput {
	/** Session source: a session key, a session id, or `@`. */
	session?: string | undefined;
	/** Rev source: any single revision. Mutually exclusive with `session`. */
	rev?: string | undefined;
	/** Publish mode: the target revision the whole folded change is placed under. */
	onto?: string | undefined;
	/** Update mode: the review bookmark to base on, append to, and advance. */
	update?: string | undefined;
	/** The caller's live session, for the current-session exemption. */
	current?: CurrentSession | undefined;
	/** A working directory for a rev or archived-session source. */
	cwd?: string | undefined;
	/** `--named [<branch>]`: name the folded change; `""` auto-names it `fold-<change id>`. */
	named?: string | undefined;
	/** Advance the single local bookmark `--onto` resolves to. */
	land?: boolean | undefined;
	/** Archive the session after a successful fold (session sources only). */
	archive?: boolean | undefined;
	/** Push each bookmark the fold advanced to the remotes that track it. */
	push?: boolean | undefined;
}

/** The fold outcome. Conflicts carry the files for the adapter to render. */
export type FoldResult =
	| {
			ok: true;
			subject: string;
			rev: string;
			ref: string;
			/** The review bookmark advanced or named, when the fold named one. */
			bookmark?: string | undefined;
			/** The folded session, when the source was one. */
			sessionKey?: string | undefined;
			/** Whether the session was archived after the fold. */
			archived?: boolean | undefined;
			/** The `bookmark` or `bookmark@remote` targets pushed; empty when `--push` did not run. */
			pushed: readonly string[];
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
	/** The source half of the folded-source marker, `<name>` in `sillajje/folded/<name>/<target>`. */
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
/** The local bookmark names pointing at a commit. */
async function localBookmarkNames(
	jj: Jj,
	commitId: string,
	cwd: string,
): Promise<string[]> {
	return (await jj.bookmarks({ cwd }))
		.filter(
			(bookmark) =>
				bookmark.remote === undefined &&
				bookmark.target.includes(commitId),
		)
		.map((bookmark) => bookmark.name);
}

/**
 * jj reserves the remote name `git` for the local Git repository. A colocated
 * repo tracks every bookmark there, but `jj git push --remote git` is
 * rejected, so it is never a push target.
 */
const LOCAL_GIT_REMOTE = "git";

/** The remote names that track a local bookmark, in listing order, deduped. */
function trackedRemotes(bookmarks: Bookmark[], name: string): string[] {
	const remotes: string[] = [];
	for (const bookmark of bookmarks) {
		if (bookmark.name !== name) continue;
		const remote = bookmark.remote;
		if (
			remote === undefined ||
			remote === LOCAL_GIT_REMOTE ||
			remotes.includes(remote)
		) {
			continue;
		}
		remotes.push(remote);
	}
	return remotes;
}

/**
 * Push one bookmark to every remote that tracks it, best-effort. A bookmark
 * with no tracking remote is pushed once with no `--remote`, which creates the
 * remote branch and starts tracking it. Returns the pushed `bookmark` or
 * `bookmark@remote` labels. The fold is already committed, so a failure warns
 * and never rolls it back.
 */
async function pushAdvancedBookmark(
	jj: Jj,
	bookmark: string,
	cwd: string,
	onStatus: StatusPort["onStatus"],
): Promise<string[]> {
	const pushed: string[] = [];
	let listed: Bookmark[];
	try {
		listed = await jj.bookmarks({ cwd });
	} catch (err) {
		emitStatus(onStatus, {
			kind: "warning",
			code: "push_failed",
			message: `fold could not list bookmarks to push: ${String(err)}`,
		});
		return pushed;
	}

	const remotes = trackedRemotes(listed, bookmark);
	// No tracking remote: push once with no `--remote`, which creates the
	// remote branch and starts tracking it.
	const destinations: (string | undefined)[] =
		remotes.length === 0 ? [undefined] : remotes;
	for (const remote of destinations) {
		const label = remote === undefined ? bookmark : `${bookmark}@${remote}`;
		try {
			const input =
				remote === undefined ? { bookmark } : { bookmark, remote };
			await jj.gitPush(input, { cwd });
			pushed.push(label);
		} catch (err) {
			emitStatus(onStatus, {
				kind: "warning",
				code: "push_failed",
				message: `fold could not push ${label}: ${String(err)}`,
			});
		}
	}
	return pushed;
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
	const names = await localBookmarkNames(jj, tip.commitId, cwd);
	const only = names[0];
	if (names.length === 1 && only !== undefined) return only;
	return slugRev(rev);
}

/**
 * The target half of the folded-source marker. A target that resolves to a
 * single local bookmark keys by that bookmark name, so a review branch keeps
 * one marker as it grows. Any other target keys by a slug of the rev string.
 */
async function foldedTargetName(
	jj: Jj,
	onto: string,
	commit: Commit | undefined,
	cwd: string,
): Promise<string> {
	if (commit !== undefined) {
		const names = await localBookmarkNames(jj, commit.commitId, cwd);
		const only = names[0];
		if (names.length === 1 && only !== undefined) return only;
	}
	return slugRev(onto);
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

		if (
			input.push === true &&
			input.update === undefined &&
			input.land !== true
		) {
			return {
				ok: false,
				reason: "usage",
				message: "--push requires --update or --land",
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
					// Fold the sealed stamp, not the mutable workspace working
					// copy. The session bookmark points at the last stamped change;
					// `@` is the fresh empty child the next interaction stamps, so
					// recording it as the base would swallow the next stamp's work.
					const bookmark = workspaces.bookmarkName(
						resolved.sessionKey,
					);
					let tip: Commit;
					try {
						tip = await resolveSingle(
							jj,
							bookmark,
							resolved.wsPath,
						);
					} catch {
						// A session with no bookmark yet folds its working copy.
						tip = await resolveSingle(jj, "@", resolved.wsPath);
					}
					source = {
						tip,
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

		// Two modes. Publish places a whole source delta under `-o`; update
		// bases on the review bookmark's recorded tip, appends the delta onto
		// that bookmark, and advances it.
		const updateMode = input.update !== undefined;
		if (
			updateMode &&
			(input.onto !== undefined ||
				input.land === true ||
				input.named !== undefined)
		) {
			return {
				ok: false,
				reason: "usage",
				message:
					"--update cannot be combined with -o, --land, or --named",
			};
		}
		const targetRevInput = updateMode ? input.update : input.onto;
		if (targetRevInput === undefined) {
			return {
				ok: false,
				reason: "usage",
				message: "fold needs -o <rev> or --update <bookmark>",
			};
		}
		const targetRev: string = targetRevInput;

		// The delta base. Publish uses the fork point. Update reads the review
		// bookmark's marker and falls back to the fork point when none exists.
		let base: Commit;
		let delta: Commit[];
		let targetCommit: Commit | undefined;
		let targetName = "";
		try {
			const targets = await jj.log(targetRev, { cwd: sourceCwd });
			targetCommit = targets.length === 1 ? targets[0] : undefined;
			if (!updateMode) {
				targetName = await foldedTargetName(
					jj,
					targetRev,
					targetCommit,
					sourceCwd,
				);
			}
			const markerName = `sillajje/folded/${source.name}/${updateMode ? targetRev : targetName}`;
			const recorded = updateMode
				? (await jj.bookmarks({ cwd: sourceCwd })).find(
						(b) => b.name === markerName && b.remote === undefined,
					)
				: undefined;
			if (recorded !== undefined && recorded.target.length > 0) {
				const recordedTarget = recorded.target[0];
				if (recordedTarget === undefined) {
					return fail(
						`fold could not resolve ${markerName} to one commit`,
					);
				}
				const recordedCommits = await jj.log(recordedTarget, {
					cwd: sourceCwd,
				});
				if (recordedCommits.length !== 1) {
					return fail(
						`fold could not resolve ${markerName} to one commit`,
					);
				}
				const recordedCommit = recordedCommits[0];
				if (recordedCommit === undefined) {
					return fail(
						`fold could not resolve ${markerName} to one commit`,
					);
				}
				base = recordedCommit;
			} else {
				if (updateMode) {
					emitStatus(onStatus, {
						kind: "info",
						code: "fold_update_fallback",
						message: `--update found no folded-source marker for ${targetRev}; folding from the fork point`,
					});
				}
				const bases = await jj.log(
					`fork_point(${tip.changeId} | ${targetRev})`,
					{ cwd: sourceCwd },
				);
				if (bases.length !== 1) {
					return fail(
						`fold could not find a single base for ${targetRev}`,
					);
				}
				const baseCommit = bases[0];
				if (baseCommit === undefined) {
					return fail(
						`fold could not find a single base for ${targetRev}`,
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

		// The published content is the tree delta. A source that merged the
		// target has a non-empty graph range but no net content; that is also a
		// no-op. Compute it here, before any mutation and before the
		// sub-generator spends a call.
		let diff = "";
		try {
			diff = await jj.diffRange(base.commitId, tip.commitId, {
				cwd: sourceCwd,
			});
		} catch (err) {
			return fail(`fold diff generation failed: ${String(err)}`);
		}
		if (diff.trim().length === 0) {
			return { ok: false, reason: "no-changes" };
		}

		// `--land` moves exactly one local bookmark pointing at the target.
		let ontoBookmark: string | undefined;
		if (input.land) {
			try {
				if (targetCommit === undefined) {
					return {
						ok: false,
						reason: "usage",
						message:
							"--land needs --onto to resolve to exactly one revision",
					};
				}
				const local = await localBookmarkNames(
					jj,
					targetCommit.commitId,
					sourceCwd,
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
				ontoBookmark = ontoLocal;
			} catch (err) {
				return fail(`fold --land resolution failed: ${String(err)}`);
			}
		}

		// Generate the body from the folded change's own diff.
		let body: string;
		let subject: string;
		try {
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

		// The name this fold carries: update uses the review bookmark; publish
		// uses --named (auto `fold-<change id>` when empty) or the target's local
		// bookmark. `reviewBookmark` is the bookmark advanced to the fold.
		const foldNameFor = (folded: Commit): string =>
			updateMode
				? targetRev
				: input.named !== undefined
					? input.named === ""
						? `fold-${folded.changeId}`
						: input.named
					: targetName;
		const reviewBookmarkFor = (folded: Commit): string | undefined =>
			updateMode
				? targetRev
				: input.named !== undefined
					? foldNameFor(folded)
					: undefined;

		// One transaction: empty child → duplicate delta → squash copies.
		const recipe = async (tx: Tx): Promise<Commit | undefined> => {
			const created = await tx.apply({
				kind: "new",
				revs: [targetRev],
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
				destination: targetRev,
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

			// Advance the review bookmark: the update target, or the --named.
			const reviewBookmark = reviewBookmarkFor(folded);
			if (reviewBookmark !== undefined) {
				const named = await tx.apply({
					kind: "bookmarkSet",
					name: reviewBookmark,
					rev: folded.changeId,
				});
				if (!named.ok) return undefined;
			}

			// Record the folded source tip for the next fold's delta base.
			const recorded = await tx.apply({
				kind: "bookmarkSet",
				name: `sillajje/folded/${source.name}/${foldNameFor(folded)}`,
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

		// Push the bookmark the fold advanced, opt-in and best-effort. `--update`
		// and `--land` are exclusive, so the fold advances at most one bookmark.
		const advancedBookmark = updateMode ? targetRev : ontoBookmark;
		let pushed: readonly string[] = [];
		if (input.push === true && advancedBookmark !== undefined) {
			emitStatus(onStatus, { kind: "phase", code: "pushing" });
			pushed = await pushAdvancedBookmark(
				jj,
				advancedBookmark,
				sourceCwd,
				onStatus,
			);
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
			bookmark: reviewBookmarkFor(folded),
			sessionKey: source.sessionKey,
			archived,
			pushed,
		};
	};
}

/** The fold subcommand — publish a source range under a target. */
export const FOLD_ARGS: CommandSpec = {
	name: "fold",
	usage: "fold (-s <id|@> | -r <rev>) (-o <rev> | --update <bookmark>) [--named [<branch>]] [--land] [--push] [--archive]",
	flags: [
		{ key: "session", aliases: ["-s", "--session"], takesValue: true },
		{ key: "rev", aliases: ["-r", "--rev"], takesValue: true },
		{ key: "onto", aliases: ["-o", "--onto"], takesValue: true },
		{ key: "update", aliases: ["-u", "--update"], takesValue: true },
		{ key: "named", aliases: ["--named"], takesValue: "optional" },
		{ key: "land", aliases: ["--land"], takesValue: false },
		{ key: "push", aliases: ["--push"], takesValue: false },
		{ key: "archive", aliases: ["--archive"], takesValue: false },
	],
	exclusive: [
		["session", "rev"],
		["update", "onto"],
		["update", "named"],
		["update", "land"],
	],
};

/** The fold subcommand's help. */
export const FOLD_HELP: CommandHelp = {
	usage: FOLD_ARGS.usage,
	lines: [
		"Publishes a source delta as one clean change under a target.",
		"  -s, --session <id>     fold a session; @ means this session (default)",
		"  -r, --rev <rev>        fold a single revision",
		"  -o, --onto <rev>       publish the whole delta under this revision",
		"  -u, --update <branch>  append only the new work onto this review bookmark",
		"      --named [<branch>] name the folded change; empty names it fold-<change id>",
		"      --land             advance --onto's single local bookmark",
		"      --push             push the advanced bookmark to its tracked remotes",
		"      --archive          archive the session after a successful fold",
		"  -h, --help             show this help",
	],
};
