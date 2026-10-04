/**
 * The fold action.
 *
 * `createFold(ports)` publishes a source delta as one clean change: it
 * aggregates the delta between a recorded base and a source tip into a single
 * change placed as a child of a target. The source branch survives.
 *
 * The mechanism, pinned by a real-jj prototype (ADR 0006):
 *
 * 1. Create an empty child of the target — the folded change.
 * 2. Duplicate the delta onto the target.
 * 3. Squash the copies into the empty child, describing it with the generated
 *    body.
 *
 * A fold records a Folded source marker at `slj/f/<dest>/<source>` when it
 * names a destination (`--named`) or advances one (`--update`), and bases on
 * the tip-most recorded tip that is an ancestor of the source. An empty
 * `--named` has no destination before the fold, so it bases on the fork point;
 * a plain `-o`, or `--no-marker`, does the same and records nothing. Markers
 * are keyed per source, so concurrent sources never collide and a handoff is
 * found by ancestry.
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

/** The fold input. `onto` names the target the folded change is placed under. */
export interface FoldInput {
	/** Session source: a session key, a session id, or `@`. */
	session?: string | undefined;
	/** Rev source: any single revision. Mutually exclusive with `session`. */
	rev?: string | undefined;
	/** The target revision the folded change is placed under. */
	onto?: string | undefined;
	/** The caller's live session, for the current-session exemption. */
	current?: CurrentSession | undefined;
	/** A working directory for a rev or archived-session source. */
	cwd?: string | undefined;
	/** `--named [<branch>]`: name the folded change; `""` auto-names it `fold-<change id>`. */
	named?: string | undefined;
	/** `--exclude <path>`: paths to leave out of the published change. */
	exclude?: readonly string[] | undefined;
	/** `--update [<bookmark>]`: advance a bookmark; empty advances the target's single local bookmark. */
	update?: string | undefined;
	/** Archive the session after a successful fold (session sources only). */
	archive?: boolean | undefined;
	/** Push the bookmark the fold advanced to the remotes that track it. */
	push?: boolean | undefined;
	/** `--no-marker`: ignore the Folded source marker and record none. */
	noMarker?: boolean | undefined;
}

/** The fold outcome. Conflicts carry the files for the adapter to render. */
export type FoldResult =
	| {
			ok: true;
			subject: string;
			rev: string;
			ref: string;
			/** The review bookmark set, when the fold named one. */
			bookmark?: string | undefined;
			/** The Folded source marker written, unless `--no-marker`. */
			marker?: string | undefined;
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
	/** The session key, when the source is a session. */
	sessionKey?: string;
	/** The marker suffix for this source: the session key, or a rev's bookmark / change id. */
	sourceName: string;
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
 * Whether a bookmark belongs to sillajje's own namespace. Session bookmarks,
 * Folded source markers, and the shorthand `slj/` tree are never a user's
 * landing target, so they are excluded from target and `--update` detection.
 */
function isExtensionBookmark(name: string): boolean {
	return name.startsWith("sillajje/") || name.startsWith("slj/");
}

/** The local bookmark names pointing at a commit, excluding sillajje's own. */
async function localBookmarkNames(
	jj: Jj,
	commitId: string,
	cwd: string,
): Promise<string[]> {
	return (await jj.bookmarks({ cwd }))
		.filter(
			(bookmark) =>
				bookmark.remote === undefined &&
				!isExtensionBookmark(bookmark.name) &&
				bookmark.target.includes(commitId),
		)
		.map((bookmark) => bookmark.name);
}

/** The single local bookmark pointing at a commit, or `undefined`. */
async function singleLocalBookmark(
	jj: Jj,
	commitId: string,
	cwd: string,
): Promise<string | undefined> {
	const names = await localBookmarkNames(jj, commitId, cwd);
	return names.length === 1 ? names[0] : undefined;
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
 * Whether `ancestor` is reachable from `descendant`. A Folded source marker
 * that is not an ancestor is not a usable base: `ancestor..descendant` would
 * include history the review branch may already hold.
 */
async function isAncestor(
	jj: Jj,
	ancestor: Commit,
	descendant: Commit,
	cwd: string,
): Promise<boolean> {
	const path = await jj.log(`${ancestor.commitId}::${descendant.commitId}`, {
		cwd,
	});
	return path.length > 0;
}

/** The Folded source marker namespace: `slj/f/<dest>/<source>`. */
const FOLDED_MARKER_NAMESPACE = "slj/f";

/**
 * Encode a destination so it occupies one marker path segment. A destination
 * and a source may both contain `/`, so without this a fold for `review` would
 * read the markers written for `review/extra`.
 */
function encodeMarkerDest(dest: string): string {
	return dest.replace(/%/g, "%25").replace(/\//g, "%2F");
}

/** The marker prefix that selects every source for a destination. */
function foldedMarkerPrefix(dest: string): string {
	return `${FOLDED_MARKER_NAMESPACE}/${encodeMarkerDest(dest)}/`;
}

/** The marker name for a destination and source. */
function foldedMarkerName(dest: string, source: string): string {
	return `${foldedMarkerPrefix(dest)}${source}`;
}

/**
 * The tip-most Folded source marker under `slj/f/<dest>/` that is an ancestor
 * of the source tip, or `undefined` when none applies. A marker per source
 * means concurrent sources never share a cursor; ancestry rather than the
 * marker's name is what selects the base, so a handoff or a renamed source
 * still finds its predecessor.
 */
async function bestMarkerBase(
	jj: Jj,
	dest: string,
	tip: Commit,
	cwd: string,
): Promise<Commit | undefined> {
	const prefix = foldedMarkerPrefix(dest);
	const markers = (await jj.bookmarks({ cwd })).filter(
		(bookmark) =>
			bookmark.remote === undefined && bookmark.name.startsWith(prefix),
	);
	let best: Commit | undefined;
	for (const marker of markers) {
		const target =
			marker.target.length === 1 ? marker.target[0] : undefined;
		if (target === undefined) continue;
		const commits = await jj.log(target, { cwd });
		const commit = commits.length === 1 ? commits[0] : undefined;
		if (commit === undefined) continue;
		if (!(await isAncestor(jj, commit, tip, cwd))) continue;
		if (best === undefined || (await isAncestor(jj, best, commit, cwd))) {
			best = commit;
		}
	}
	return best;
}

/**
 * The source half of the Folded source marker. A rev that names a single local
 * bookmark keys by that name; any other rev keys by its change id, which is
 * stable across a rewrite.
 */
async function revSourceName(
	jj: Jj,
	tip: Commit,
	cwd: string,
): Promise<string> {
	return (await singleLocalBookmark(jj, tip.commitId, cwd)) ?? tip.changeId;
}

/**
 * Compile `--exclude` values into one included-fileset expression: each value
 * is a workspace-relative path prefix or glob, unioned and complemented so jj
 * selects everything else. `undefined` when nothing is excluded.
 */
function includedFileset(
	exclude: readonly string[] | undefined,
): string | undefined {
	if (exclude === undefined || exclude.length === 0) return undefined;
	const patterns = exclude.map(
		(value) => `prefix-glob:"${escapeFilesetValue(value)}"`,
	);
	return `~(${patterns.join(" | ")})`;
}

/** Escape a value for a jj fileset string literal: backslash first, then quote. */
function escapeFilesetValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

		if (input.named !== undefined && input.update !== undefined) {
			return {
				ok: false,
				reason: "usage",
				message: "--named and --update are mutually exclusive",
			};
		}

		if (input.push === true && input.update === undefined) {
			return {
				ok: false,
				reason: "usage",
				message: "--push requires --update",
			};
		}

		if (input.onto === undefined) {
			return {
				ok: false,
				reason: "usage",
				message: "fold needs -o <rev>",
			};
		}
		const targetRev: string = input.onto;

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
						sessionKey: resolved.sessionKey,
						sourceName: resolved.sessionKey,
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
						sessionKey,
						sourceName: sessionKey,
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
					sourceName: await revSourceName(jj, tip, cwd),
					cwd,
				};
			}
		} catch (err) {
			return fail(`fold source resolution failed: ${String(err)}`);
		}

		const { tip } = source;
		const sourceCwd = source.cwd;
		const fileset = includedFileset(input.exclude);

		// The marker is opt-in. It exists only when the fold names a destination
		// (`--named`) or advances one (`--update`); a plain `-o` is a one-shot
		// publish that neither reads nor writes the store. When a marker applies,
		// the base is its tip-most recorded tip that is an ancestor of the source;
		// otherwise the fork point. `--no-marker` skips the store.
		let targetCommit: Commit | undefined;
		let localBookmarks: string[] = [];
		try {
			const targets = await jj.log(targetRev, { cwd: sourceCwd });
			targetCommit = targets.length === 1 ? targets[0] : undefined;
			if (targetCommit !== undefined) {
				localBookmarks = await localBookmarkNames(
					jj,
					targetCommit.commitId,
					sourceCwd,
				);
			}
		} catch (err) {
			return fail(`fold destination resolution failed: ${String(err)}`);
		}

		// `--update [<bookmark>]` advances a bookmark after the fold. Without a
		// value it needs the target's single local bookmark.
		let updateBookmark: string | undefined;
		if (input.update !== undefined) {
			if (input.update !== "") {
				updateBookmark = input.update;
			} else if (localBookmarks.length === 1) {
				updateBookmark = localBookmarks[0];
			} else {
				return {
					ok: false,
					reason: "usage",
					message:
						localBookmarks.length === 0
							? `--update found no local bookmark on ${targetRev}; pass --update <bookmark>`
							: `--update found ${localBookmarks.length} local bookmarks on ${targetRev} (${localBookmarks.join(", ")}); pass --update <bookmark>`,
				};
			}
		}

		// The marker destination: a named branch or the bookmark `--update`
		// advances. An empty `--named` is named after the folded change, which
		// does not exist before the fold, so `changeId` is undefined there.
		const markerDestFor = (changeId?: string): string | undefined => {
			if (input.named === "") {
				return changeId === undefined ? undefined : `fold-${changeId}`;
			}
			if (input.named !== undefined) return input.named;
			if (input.update !== undefined) return updateBookmark;
			return undefined;
		};
		const destPreFold = markerDestFor();

		let base: Commit;
		let delta: Commit[];
		try {
			const recorded =
				input.noMarker === true || destPreFold === undefined
					? undefined
					: await bestMarkerBase(jj, destPreFold, tip, sourceCwd);
			if (recorded !== undefined) {
				base = recorded;
			} else {
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
				...(fileset === undefined ? {} : { filesets: [fileset] }),
			});
		} catch (err) {
			return fail(`fold diff generation failed: ${String(err)}`);
		}
		if (diff.trim().length === 0) {
			return { ok: false, reason: "no-changes" };
		}

		if (fileset !== undefined) {
			emitStatus(onStatus, {
				kind: "info",
				code: "fold_excluded",
				message: `fold leaves out ${(input.exclude ?? []).join(", ")}`,
			});
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
				{
					subject,
					summary: smartWrap(summary.text, 72),
					ref,
					skipped: input.exclude ?? [],
				},
				cfg.body,
			);
		} catch (err) {
			return fail(`fold message generation failed: ${String(err)}`);
		}

		emitStatus(onStatus, {
			kind: "phase",
			code: "folding",
			target: targetRev,
		});

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
				...(fileset === undefined
					? {}
					: { filesets: [fileset], keepEmptied: true }),
			});
			if (!squashed.ok) return undefined;

			// An unfiltered squash empties the copies and jj abandons them. A
			// partial squash leaves the excluded paths behind, so the copies are
			// abandoned explicitly. `keepEmptied` keeps the whole range alive: jj
			// abandons an emptied copy, and the abandoned change id then drops out
			// of `<root>::<head>`, which would leave the later copies behind.
			if (fileset !== undefined) {
				const pruned = await tx.apply({
					kind: "abandon",
					revset: `${root.changeId}::${head.changeId}`,
				});
				if (!pruned.ok) return undefined;
			}

			// A conflict is an expected abort; throwing rolls the chain back.
			const conflicts = await tx.conflicts(folded.changeId);
			if (conflicts.length > 0) throw new FoldAbort(conflicts);

			const dest = markerDestFor(folded.changeId);

			// With `--named` the fold also names a review bookmark.
			if (input.named !== undefined) {
				if (dest === undefined) {
					throw new Error("fold: a named destination must resolve");
				}
				const named = await tx.apply({
					kind: "bookmarkSet",
					name: dest,
					rev: folded.changeId,
				});
				if (!named.ok) return undefined;
			}

			// Record the folded source tip for the next fold's delta base. The
			// marker only exists for a stable destination, and is keyed per source,
			// so it never overwrites another source's.
			if (input.noMarker !== true && dest !== undefined) {
				const recorded = await tx.apply({
					kind: "bookmarkSet",
					name: foldedMarkerName(dest, source.sourceName),
					rev: tip.changeId,
				});
				if (!recorded.ok) return undefined;
			}

			if (updateBookmark !== undefined) {
				const landed = await tx.apply({
					kind: "bookmarkSet",
					name: updateBookmark,
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

		// Push the bookmark `--update` advanced, opt-in and best-effort.
		const advancedBookmark = updateBookmark;
		let pushed: readonly string[] = [];
		if (input.push === true && advancedBookmark !== undefined) {
			emitStatus(onStatus, {
				kind: "phase",
				code: "pushing",
				target: advancedBookmark,
			});
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

		const dest = markerDestFor(folded.changeId);
		return {
			ok: true,
			subject,
			rev: folded.changeId,
			ref: `${base.changeId}..${tip.changeId}`,
			bookmark: input.named === undefined ? undefined : dest,
			marker:
				input.noMarker === true || dest === undefined
					? undefined
					: foldedMarkerName(dest, source.sourceName),
			sessionKey: source.sessionKey,
			archived,
			pushed,
		};
	};
}

/** The fold subcommand — publish a source range under a target. */
export const FOLD_ARGS: CommandSpec = {
	name: "fold",
	usage: "fold (-s <id|@> | -r <rev>) -o <rev> [--named [<branch>]] [--update [<bookmark>]] [--push] [--archive] [--exclude <path>] [--no-marker]",
	flags: [
		{ key: "session", aliases: ["-s", "--session"], takesValue: true },
		{ key: "rev", aliases: ["-r", "--rev"], takesValue: true },
		{ key: "onto", aliases: ["-o", "--onto"], takesValue: true },
		{ key: "named", aliases: ["--named"], takesValue: "optional" },
		{ key: "update", aliases: ["-u", "--update"], takesValue: "optional" },
		{ key: "push", aliases: ["--push"], takesValue: false },
		{ key: "archive", aliases: ["--archive"], takesValue: false },
		{ key: "noMarker", aliases: ["--no-marker"], takesValue: false },
		{
			key: "exclude",
			aliases: ["--exclude"],
			takesValue: true,
			repeatable: true,
		},
	],
	exclusive: [
		["session", "rev"],
		["named", "update"],
	],
};

/** The fold subcommand's help. */
export const FOLD_HELP: CommandHelp = {
	usage: FOLD_ARGS.usage,
	lines: [
		"Publishes a source delta as one clean change under a target.",
		"  -s, --session <id>     fold a session; @ means this session (default)",
		"  -r, --rev <rev>        fold a single revision",
		"  -o, --onto <rev>       place the folded change under this revision",
		"      --named [<branch>] name the folded change; empty names it fold-<change id>",
		"  -u, --update [<bookmark>] advance the target bookmark, or <bookmark>",
		"      --push             push the advanced bookmark to its tracked remotes",
		"      --archive          archive the session after a successful fold",
		"      --exclude <path>   leave paths out of the published change (repeatable)",
		"      --no-marker        ignore and write no Folded source marker",
		"  -h, --help             show this help",
		"",
		"A fold that names or advances a destination records a Folded source marker",
		"at slj/f/<dest>/<source> and bases on the tip-most recorded tip that is an",
		"ancestor of the source, so a later fold publishes only the new work.",
	],
};
