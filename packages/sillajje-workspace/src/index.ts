/**
 * `@pi-tre/sillajje-workspace` — workspace lifecycle and session targeting.
 *
 * Two faces over the typed `Jj` facade:
 *
 * - **Lifecycle** creates, resolves, archives, and unarchives a session's jj
 *   workspace, and owns the directory and its registration.
 * - **Session targeting** answers which workspace a session owns, with the
 *   session rule: no bookmark is not a sillajje session; a bookmark owned by
 *   another owner is foreign; a bookmark without a workspace is archived.
 *
 * The package owns no session state. It takes a session id, a workspace root,
 * and a session owner, and passes values in. It never builds jj argv and never
 * names the process.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { basename, dirname } from "node:path";
import type { ExecOptions, Jj } from "@pi-tre/sillajje-jj";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceInfo {
	/** Qualified session identity: `<owner>/<session-id>`. */
	sessionKey: string;
	/** jj workspace name: `sillajje/<sessionKey>`. */
	workspaceName: string;
	/** Absolute workspace directory: `<workspacesRoot>/<repo-slug>/<session-id>`. */
	workspacePath: string;
}

export interface WorkspacesOptions {
	/** Absolute path to the jj repo root. */
	repoRoot: string;
	/** Directory that holds every session's workspace. */
	workspacesRoot: string;
	/** Session owner: `<user>/<host>`. */
	owner: string;
}

export interface CurrentSession {
	sessionKey?: string | undefined;
	wsPath?: string | undefined;
}

export type ArchiveOutcome =
	| { status: "removed" }
	| { status: "already-gone" }
	| { status: "failed"; reason: string };

/**
 * The outcome of `ensure`: a live workspace, reused or created, or an archived
 * session that must be unarchived explicitly.
 */
export type EnsureResult =
	| { ok: true; status: "reused"; workspace: WorkspaceInfo }
	| {
			ok: true;
			status: "created";
			workspace: WorkspaceInfo;
			/**
			 * True when the base resolved to `root()` — the repo has no `trunk()`,
			 * or an explicit base is the empty tree — so the session starts empty.
			 */
			fromRoot: boolean;
	  }
	| { ok: false; reason: "archived" };

export type SessionTargetResolution =
	| { ok: true; sessionKey: string; wsPath: string }
	| { ok: false; reason: "not-a-session" | "foreign" | "archived" };

/**
 * The outcome of resolving a session named as a Base source. Unlike a session
 * target, an archived session resolves: the bookmark is all the caller needs,
 * and the workspace may not exist.
 */
export type BaseSourceResolution =
	| { ok: true; sessionKey: string; revision: string }
	| { ok: false; reason: "not-a-session" | "foreign" };

export interface Workspaces {
	/** Canonical session key: a raw id gains the owner, a full key passes through. */
	sessionKey(target: string): string;
	/** The owner half of a session key: `<user>/<host>`. */
	ownerOf(sessionKey: string): string;
	/** The session id, without the owner. */
	unqualified(sessionKey: string): string;
	/** jj workspace name for a session key. */
	workspaceName(sessionKey: string): string;
	/** Bookmark name for a session key. */
	bookmarkName(sessionKey: string): string;
	/** Workspace directory for a session key; owner-free. */
	workspacePath(sessionKey: string): string;

	/**
	 * Ensure the session's workspace, creating it when absent. `options.base`
	 * is the revision a new workspace branches from; it defaults to `trunk()`.
	 */
	ensure(
		sessionId: string,
		options?: { base?: string },
	): Promise<EnsureResult>;
	lookup(sessionKey: string): Promise<string | undefined>;
	archive(sessionKey: string): Promise<ArchiveOutcome>;
	unarchive(sessionKey: string): Promise<WorkspaceInfo>;
	resolveTarget(
		target: string,
		current: CurrentSession,
	): Promise<SessionTargetResolution>;
	/** Resolve a session named as a Base source to its bookmark. */
	resolveBaseSource(target: string): Promise<BaseSourceResolution>;
}

// ---------------------------------------------------------------------------
// Owner
// ---------------------------------------------------------------------------

function slugPart(value: string): string {
	const slug = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "unknown";
}

/**
 * Build a session owner from a user and host. Each half is slugged to a
 * jj-safe name: a space makes `jj workspace list -T` quote the name and breaks
 * the parser, so it never reaches a workspace name.
 */
export function ownerFrom(user: string, host: string): string {
	return `${slugPart(user)}/${slugPart(host)}`;
}

/** The owner of the running process: the OS user and hostname. */
export function defaultOwner(): string {
	let user = "unknown";
	try {
		user = userInfo().username;
	} catch {
		// No passwd entry — fall back to "unknown".
	}
	return ownerFrom(user, hostname());
}

/** The repository's directory name under the workspaces root. */
export function repoSlug(repoRoot: string): string {
	return basename(repoRoot);
}

/** Whether a workspace directory exists on disk. */
export function directoryExists(path: string): boolean {
	return existsSync(path);
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createWorkspaces(
	jj: Jj,
	options: WorkspacesOptions,
): Workspaces {
	const { repoRoot, workspacesRoot } = options;
	// Normalize the owner to exactly `user/host`.
	const owner = options.owner.includes("/")
		? options.owner
		: `${options.owner}/unknown`;
	const slug = repoSlug(repoRoot);
	const jjOptions: ExecOptions = { cwd: repoRoot };

	const workspaceName = (sessionKey: string): string =>
		`sillajje/${sessionKey}`;
	const bookmarkName = (sessionKey: string): string =>
		`sillajje/${sessionKey}`;

	/** The session id, without the owner. */
	const unqualified = (sessionKey: string): string =>
		sessionKey.split("/").slice(2).join("/");
	const ownerOf = (sessionKey: string): string =>
		sessionKey.split("/").slice(0, 2).join("/");
	const pathOf = (sessionKey: string): string =>
		`${workspacesRoot}/${slug}/${unqualified(sessionKey)}`;

	/** A target names a full key when it carries a slash, else a raw session id. */
	const qualify = (target: string): string =>
		target.includes("/") ? target : `${owner}/${target}`;

	/**
	 * New sessions branch from the trunk revset by default, not the main
	 * working copy's parent. `trunk()` is the repo's integration point (jj's
	 * built-in default is the latest `main`/`master`/`trunk` remote bookmark,
	 * overridable via `revset-aliases."trunk()"`), so a session never inherits
	 * unlanded work from the main checkout. A caller may name a different base
	 * — the revision a session's workspace branches from.
	 */
	const defaultBase = "trunk()";

	/**
	 * Resolve the base once: the revision to branch from and whether it is
	 * `root()`. A separate probe and `workspace add` could disagree if a
	 * concurrent bookmark update lands between them.
	 */
	const resolveBase = async (
		base?: string,
	): Promise<{
		revision: string;
		fromRoot: boolean;
	}> => {
		const revset = base ?? defaultBase;
		const [tip] = await jj.log(revset, jjOptions);
		if (tip === undefined) {
			// `trunk()` always resolves (to `root()` at worst); this is defensive,
			// and the following `workspace add` surfaces the error.
			return { revision: revset, fromRoot: true };
		}
		return {
			revision: tip.commitId,
			fromRoot: tip.parents.length === 0,
		};
	};

	/**
	 * Forget a workspace name without failing the caller. jj warns and exits 0
	 * for an unknown name, so this clears a phantom registration; a hard failure
	 * surfaces on the following `workspace add`.
	 */
	const forgetQuietly = async (name: string): Promise<void> => {
		try {
			await jj.workspaceForget(name, jjOptions);
		} catch {
			// Best effort — the add that follows is the authority.
		}
	};

	/** Whether the session's bookmark exists. */
	const hasBookmark = async (sessionKey: string): Promise<boolean> => {
		const name = bookmarkName(sessionKey);
		return (await jj.bookmarks(jjOptions)).some((b) => b.name === name);
	};

	return {
		sessionKey: qualify,
		ownerOf,
		unqualified,
		workspaceName,
		bookmarkName,
		workspacePath: pathOf,

		async ensure(sessionId, options) {
			const list = await jj.workspaces(jjOptions);
			const byName = new Map(list.map((w) => [w.name, w]));
			let key = sessionId;
			let suffix = 2;
			for (;;) {
				const sessionKey = `${owner}/${key}`;
				const name = workspaceName(sessionKey);
				const path = pathOf(sessionKey);
				const found = byName.get(name);

				// Reuse only when the name is registered AND its directory lives.
				if (found?.root && existsSync(found.root)) {
					return {
						ok: true,
						status: "reused",
						workspace: {
							sessionKey,
							workspaceName: name,
							workspacePath: found.root,
						},
					};
				}
				// A surviving bookmark means the session is archived, not new.
				// Never rebuild it here; unarchive is the explicit path.
				if (await hasBookmark(sessionKey)) {
					return { ok: false, reason: "archived" };
				}
				// Orphan directory: never trust it, never delete it.
				if (!found && existsSync(path)) {
					key = `${sessionId}-${suffix++}`;
					continue;
				}

				const { revision, fromRoot } = await resolveBase(options?.base);
				mkdirSync(dirname(path), { recursive: true });
				await forgetQuietly(name);
				await jj.workspaceAdd({ name, revision, path }, jjOptions);
				return {
					ok: true,
					status: "created",
					workspace: {
						sessionKey,
						workspaceName: name,
						workspacePath: path,
					},
					fromRoot,
				};
			}
		},

		async lookup(sessionKey) {
			const name = workspaceName(sessionKey);
			const found = (await jj.workspaces(jjOptions)).find(
				(w) => w.name === name,
			);
			return found?.root;
		},

		async archive(sessionKey) {
			const name = workspaceName(sessionKey);
			// Remove the registered root when jj names one, else the computed
			// path. A registration can point outside the workspaces root.
			const found = (await jj.workspaces(jjOptions)).find(
				(w) => w.name === name,
			);
			const path = found?.root ? found.root : pathOf(sessionKey);
			try {
				await jj.workspaceForget(name, jjOptions);
			} catch (error) {
				return { status: "failed", reason: errorMessage(error) };
			}
			const existed = existsSync(path);
			try {
				rmSync(path, { recursive: true, force: true });
			} catch (error) {
				return { status: "failed", reason: errorMessage(error) };
			}
			return existed ? { status: "removed" } : { status: "already-gone" };
		},

		async unarchive(sessionKey) {
			const name = workspaceName(sessionKey);
			const path = pathOf(sessionKey);
			mkdirSync(dirname(path), { recursive: true });
			await forgetQuietly(name);
			await jj.workspaceAdd(
				{ name, revision: bookmarkName(sessionKey), path },
				jjOptions,
			);
			return { sessionKey, workspaceName: name, workspacePath: path };
		},

		async resolveTarget(target, current) {
			const sessionKey = qualify(target);

			if (
				current.sessionKey !== undefined &&
				sessionKey === current.sessionKey &&
				current.wsPath !== undefined
			) {
				return { ok: true, sessionKey, wsPath: current.wsPath };
			}

			const isForeign = ownerOf(sessionKey) !== owner;
			const name = workspaceName(sessionKey);
			const found = (await jj.workspaces(jjOptions)).find(
				(w) => w.name === name,
			);
			if (found?.root) {
				return isForeign
					? { ok: false, reason: "foreign" }
					: { ok: true, sessionKey, wsPath: found.root };
			}

			if (!(await hasBookmark(sessionKey))) {
				return { ok: false, reason: "not-a-session" };
			}
			if (isForeign) {
				return { ok: false, reason: "foreign" };
			}
			return { ok: false, reason: "archived" };
		},

		async resolveBaseSource(target) {
			const sessionKey = qualify(target);
			if (!(await hasBookmark(sessionKey))) {
				return { ok: false, reason: "not-a-session" };
			}
			if (ownerOf(sessionKey) !== owner) {
				return { ok: false, reason: "foreign" };
			}
			return { ok: true, sessionKey, revision: bookmarkName(sessionKey) };
		},
	};
}
