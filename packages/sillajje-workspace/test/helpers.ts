import type { Bookmark, Commit, Jj, Workspace } from "@pi-tre/sillajje-jj";

/** Mutable state a fake `Jj` reads and records into. */
export interface FakeJjState {
	workspaces: Workspace[];
	bookmarks: Bookmark[];
	added: { name: string; revision: string; path: string }[];
	forgotten: string[];
	/** Read verbs invoked, in order; used to assert the trusted path skips jj. */
	reads: string[];
	/** When set, `workspaceAdd` rejects with this message. */
	addError?: string;
	/** When set, `workspaceForget` rejects with this message. */
	forgetError?: string;
	/** Result `jj.log` returns. Empty simulates a repo with no `trunk()`. */
	logResult: Commit[];
}

/**
 * A fake `Jj` covering the verbs the workspace package uses. Reads return the
 * mutable state; workspace verbs record their calls.
 */
export function fakeJj(overrides: Partial<FakeJjState> = {}): {
	jj: Jj;
	state: FakeJjState;
} {
	const state: FakeJjState = {
		workspaces: [],
		bookmarks: [],
		added: [],
		forgotten: [],
		reads: [],
		logResult: [
			{
				commitId: "trunk-commit",
				changeId: "trunk-change",
				parents: ["parent"],
				description: "trunk",
			},
		],
		...overrides,
	};

	const jj: Jj = {
		log: async () => {
			state.reads.push("log");
			return state.logResult;
		},
		diff: async () => "",
		diffRange: async () => "",
		version: async () => ({
			major: 0,
			minor: 44,
			patch: 0,
			raw: "jj 0.44.0",
		}),
		checkVersion: async () => ({
			status: "validated",
			version: { major: 0, minor: 44, patch: 0, raw: "jj 0.44.0" },
		}),
		conflicts: async () => [],
		bookmarks: async () => {
			state.reads.push("bookmarks");
			return state.bookmarks;
		},
		workspaces: async () => {
			state.reads.push("workspaces");
			return state.workspaces;
		},
		apply: async () => ({ ok: true, value: { op: "op", created: [] } }),
		transaction: async (recipe) => ({
			ok: true,
			value: await recipe({ apply: jj.apply, conflicts: jj.conflicts }),
		}),
		workspaceAdd: async (input) => {
			if (state.addError) throw new Error(state.addError);
			state.added.push(input);
			return { name: input.name, root: input.path };
		},
		workspaceForget: async (name) => {
			if (state.forgetError) throw new Error(state.forgetError);
			state.forgotten.push(name);
		},
		workspaceUpdateStale: async () => {},
	};

	return { jj, state };
}
