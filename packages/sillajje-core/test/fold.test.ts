/**
 * The fold action's seam: build it with fake ports and a recording sink, then
 * assert the result, the status stream, and the transaction recipe.
 */

import type { Bookmark, Commit, Jj } from "@pi-tre/sillajje-jj";
import type {
	ArchiveOutcome,
	CurrentSession,
	SessionTargetResolution,
	Workspaces,
} from "@pi-tre/sillajje-workspace";
import { describe, expect, it, vi } from "vitest";
import {
	createFold,
	defaultSillajjeConfig,
	type StatusEvent,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE: Commit = {
	commitId: "base-c",
	changeId: "base",
	parents: [],
	description: "A",
};
const TIP: Commit = {
	commitId: "tip-c",
	changeId: "tip",
	parents: ["prev-c"],
	description: "F",
};
const FOLDED: Commit = {
	commitId: "folded-c",
	changeId: "folded",
	parents: ["main-c"],
	description: "",
};
const COPY_ROOT: Commit = {
	commitId: "c1",
	changeId: "c1",
	parents: ["main-c"],
	description: "D",
};
const COPY_HEAD: Commit = {
	commitId: "c2",
	changeId: "c2",
	parents: ["c1"],
	description: "E",
};
const MAIN: Commit = {
	commitId: "main-c",
	changeId: "main",
	parents: [],
	description: "B",
};
const PREV: Commit = {
	commitId: "prev-c",
	changeId: "prev",
	parents: ["base-c"],
	description: "F1",
};

const CURRENT: CurrentSession = { sessionKey: "owner/s1", wsPath: "/ws" };

/** The commit graph the fake jj resolves ancestry against. */
const GRAPH = new Map<string, readonly string[]>(
	[BASE, PREV, TIP, MAIN, FOLDED, COPY_ROOT, COPY_HEAD].map((commit) => [
		commit.commitId,
		commit.parents,
	]),
);

/** Whether `ancestorId` is reachable from `descendantId` in the fake graph. */
function isAncestorOf(ancestorId: string, descendantId: string): boolean {
	const seen = new Set<string>();
	const stack = [descendantId];
	while (stack.length > 0) {
		const id = stack.pop();
		if (id === undefined || seen.has(id)) continue;
		if (id === ancestorId) return true;
		seen.add(id);
		stack.push(...(GRAPH.get(id) ?? []));
	}
	return false;
}

interface Fakes {
	jj: Jj;
	log: ReturnType<typeof vi.fn>;
	apply: ReturnType<typeof vi.fn>;
	conflicts: ReturnType<typeof vi.fn>;
	bookmarks: ReturnType<typeof vi.fn>;
	gitPush: ReturnType<typeof vi.fn>;
	transaction: ReturnType<typeof vi.fn>;
	diffRange: ReturnType<typeof vi.fn>;
}

function makeJj(opts?: {
	delta?: Commit[];
	conflicts?: string[];
	bookmarks?: Bookmark[];
	/** Commit ids `jj log` resolves to no revision. */
	logEmptyFor?: string[];
}): Fakes {
	const delta = opts?.delta ?? [TIP];
	const log = vi.fn(async (revset: string) => {
		if (opts?.logEmptyFor?.includes(revset)) return [];
		if (revset === "feat" || revset === "@") return [TIP];
		if (revset === "main") return [MAIN];
		if (revset === MAIN.commitId) return [MAIN];
		if (revset === PREV.commitId) return [PREV];
		if (revset.startsWith("fork_point")) return [BASE];
		if (revset.startsWith("sillajje/")) return [TIP];
		const range = /^(.+)::(.+)$/.exec(revset);
		if (range) {
			const [, ancestor, descendant] = range;
			return isAncestorOf(ancestor ?? "", descendant ?? "") ? [TIP] : [];
		}
		if (revset.includes("..")) return delta;
		throw new Error(`unexpected log revset: ${revset}`);
	});
	const apply = vi.fn(async (mutation: { kind: string }) => {
		if (mutation.kind === "new") {
			return { ok: true, value: { op: "op-new", created: [FOLDED] } };
		}
		if (mutation.kind === "duplicate") {
			return {
				ok: true,
				value: { op: "op-dup", created: [COPY_ROOT, COPY_HEAD] },
			};
		}
		return { ok: true, value: { op: "op-squash", created: [] } };
	});
	const conflicts = vi.fn(async () => opts?.conflicts ?? []);
	const bookmarks = vi.fn(async () => opts?.bookmarks ?? []);
	const gitPush = vi.fn(async () => {});
	const transaction = vi.fn(
		async (recipe: (tx: unknown) => Promise<unknown>) => {
			const tx = { apply, conflicts };
			const value = await recipe(tx);
			return { ok: true, value };
		},
	);
	const diffRange = vi.fn(async () => "diff --git a/f b/f\n+added");
	const jj = {
		log,
		diff: vi.fn(async () => "diff --git a/f b/f\n+added"),
		diffRange,
		bookmarks,
		gitPush,
		transaction,
	} as unknown as Jj;
	return {
		jj,
		log,
		apply,
		conflicts,
		bookmarks,
		gitPush,
		transaction,
		diffRange,
	};
}

function makeWorkspaces(
	resolve: (
		target: string,
		current: CurrentSession,
	) => Promise<SessionTargetResolution>,
	archive: () => Promise<ArchiveOutcome> = async (): Promise<ArchiveOutcome> => ({
		status: "removed",
	}),
): Workspaces {
	return {
		sessionKey: (target: string) =>
			target.includes("/") ? target : `owner/${target}`,
		bookmarkName: (key: string) => `sillajje/${key}`,
		resolveTarget: resolve,
		archive,
	} as unknown as Workspaces;
}

function collectingSink(): {
	onStatus: (event: StatusEvent) => void;
	statuses: StatusEvent[];
} {
	const statuses: StatusEvent[] = [];
	return { onStatus: (event) => statuses.push(event), statuses };
}

const RUN = async () => ({ text: "test subject\ntrace narrative" });

function fold(opts?: {
	jj?: Fakes;
	resolve?: (
		target: string,
		current: CurrentSession,
	) => Promise<SessionTargetResolution>;
	archive?: () => Promise<ArchiveOutcome>;
}) {
	const fakes = opts?.jj ?? makeJj();
	const archive = vi.fn(
		opts?.archive ??
			(async (): Promise<ArchiveOutcome> => ({ status: "removed" })),
	);
	const workspaces = makeWorkspaces(
		opts?.resolve ??
			(async () => ({
				ok: true,
				sessionKey: "owner/s1",
				wsPath: "/ws",
			})),
		archive,
	);
	const { onStatus, statuses } = collectingSink();
	const action = createFold({
		jj: fakes.jj,
		workspaces,
		config: defaultSillajjeConfig(),
		onStatus,
		run: RUN,
	});
	return { action, fakes, statuses, archive };
}

/** Assert that `--update` ignores a marker and folds from the fork point. */
async function expectUpdateFallsBack(
	bookmarks: Bookmark[],
	opts?: { logEmptyFor?: string[] },
): Promise<void> {
	const fakes = makeJj({ bookmarks, ...opts });
	const { action, statuses } = fold({ jj: fakes });

	const result = await action({ rev: "feat", update: "main" });

	expect(result.ok).toBe(true);
	const duplicate = fakes.apply.mock.calls.find(
		(c) => (c[0] as { kind: string }).kind === "duplicate",
	)?.[0] as { revset: string };
	expect(duplicate.revset).toBe("base-c..tip-c");
	expect(statuses).toContainEqual(
		expect.objectContaining({ code: "fold_update_fallback" }),
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createFold", () => {
	it("runs the new → duplicate → squash recipe in one transaction", async () => {
		const { action, fakes, statuses } = fold();

		const result = await action({ rev: "feat", onto: "main" });

		expect(result).toEqual({
			ok: true,
			subject: "test subject",
			rev: "folded",
			ref: "base..tip",
			pushed: [],
		});

		// The recipe's three mutations.
		expect(fakes.apply).toHaveBeenCalledWith({
			kind: "new",
			revs: ["main"],
			edit: false,
		});
		expect(fakes.apply).toHaveBeenCalledWith({
			kind: "duplicate",
			revset: "base-c..tip-c",
			destination: "main",
		});
		const squash = fakes.apply.mock.calls.find(
			(c) => (c[0] as { kind: string }).kind === "squash",
		)?.[0] as { from: string; onto: string; message: string };
		expect(squash.from).toBe("c1::c2");
		expect(squash.onto).toBe("folded");
		expect(squash.message).toContain("test subject");
		expect(squash.message).toContain("Summary:");
		expect(squash.message).toContain("Ref: base..tip");
		expect(squash.message).not.toContain("Skipped");
		expect(squash.message).not.toContain("Meta:");
		expect(squash.message).not.toContain("Loop:");

		expect(fakes.transaction).toHaveBeenCalledTimes(1);
		expect(statuses).toEqual([{ kind: "phase", code: "folding" }]);
	});

	it("leaves excluded paths out of the squash, the diff, and the copies", async () => {
		const { action, fakes } = fold();

		const result = await action({
			rev: "feat",
			onto: "main",
			exclude: [".scratch/"],
		});

		expect(result.ok).toBe(true);
		const fileset = '~(prefix-glob:".scratch/")';
		const squash = fakes.apply.mock.calls.find(
			(c) => (c[0] as { kind: string }).kind === "squash",
		)?.[0] as { filesets?: readonly string[] };
		expect(squash.filesets).toEqual([fileset]);
		expect(fakes.apply).toHaveBeenCalledWith({
			kind: "abandon",
			revset: "c1::c2",
		});
		expect(fakes.diffRange).toHaveBeenCalledWith("base-c", "tip-c", {
			cwd: ".",
			filesets: [fileset],
		});
	});

	it("names the excluded paths in the Skipped line", async () => {
		const { action, fakes } = fold();

		await action({
			rev: "feat",
			onto: "main",
			exclude: [".scratch/", "*.lock"],
		});

		const squash = fakes.apply.mock.calls.find(
			(c) => (c[0] as { kind: string }).kind === "squash",
		)?.[0] as { message: string };
		expect(squash.message).toContain("Skipped: .scratch/, *.lock");
	});

	it("reports the exclusion as an info status", async () => {
		const { action, statuses } = fold();

		await action({ rev: "feat", onto: "main", exclude: [".scratch/"] });

		expect(statuses).toContainEqual(
			expect.objectContaining({
				kind: "info",
				code: "fold_excluded",
				message: expect.stringContaining(".scratch/"),
			}),
		);
	});

	it("compiles several excluded paths into one fileset", async () => {
		const { action, fakes } = fold();

		await action({
			rev: "feat",
			onto: "main",
			exclude: [".scratch/", "*.lock"],
		});

		const squash = fakes.apply.mock.calls.find(
			(c) => (c[0] as { kind: string }).kind === "squash",
		)?.[0] as { filesets?: readonly string[] };
		expect(squash.filesets).toEqual([
			'~(prefix-glob:".scratch/" | prefix-glob:"*.lock")',
		]);
	});

	it("escapes a quote or backslash in an excluded path", async () => {
		const { action, fakes } = fold();

		await action({
			rev: "feat",
			onto: "main",
			exclude: ['we"ird', "back\\slash"],
		});

		const squash = fakes.apply.mock.calls.find(
			(c) => (c[0] as { kind: string }).kind === "squash",
		)?.[0] as { filesets?: readonly string[] };
		expect(squash.filesets).toEqual([
			'~(prefix-glob:"we\\"ird" | prefix-glob:"back\\\\slash")',
		]);
	});

	it("passes no fileset and abandons nothing without --exclude", async () => {
		const { action, fakes } = fold();

		await action({ rev: "feat", onto: "main" });

		const squash = fakes.apply.mock.calls.find(
			(c) => (c[0] as { kind: string }).kind === "squash",
		)?.[0] as { filesets?: readonly string[] };
		expect(squash.filesets).toBeUndefined();
		expect(
			fakes.apply.mock.calls.some(
				(c) => (c[0] as { kind: string }).kind === "abandon",
			),
		).toBe(false);
		expect(fakes.diffRange).toHaveBeenCalledWith("base-c", "tip-c", {
			cwd: ".",
		});
	});

	it("returns no-changes when every changed path is excluded", async () => {
		const fakes = makeJj();
		fakes.diffRange.mockResolvedValue("");
		const { action } = fold({ jj: fakes });

		const result = await action({
			rev: "feat",
			onto: "main",
			exclude: [".scratch/"],
		});

		expect(result).toEqual({ ok: false, reason: "no-changes" });
		expect(fakes.transaction).not.toHaveBeenCalled();
	});

	it("excludes paths in --update mode too", async () => {
		const fakes = makeJj({
			bookmarks: [{ name: "sillajje/folded/main", target: ["prev-c"] }],
		});
		const { action } = fold({ jj: fakes });

		const result = await action({
			rev: "feat",
			update: "main",
			exclude: [".scratch/"],
		});

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.bookmark).toBe("main");
		const squash = fakes.apply.mock.calls.find(
			(c) => (c[0] as { kind: string }).kind === "squash",
		)?.[0] as { filesets?: readonly string[] };
		expect(squash.filesets).toEqual(['~(prefix-glob:".scratch/")']);
		expect(fakes.apply).toHaveBeenCalledWith({
			kind: "bookmarkSet",
			name: "sillajje/folded/main",
			rev: "tip",
		});
	});

	it("combines --exclude with --named and --land", async () => {
		const fakes = makeJj({
			bookmarks: [{ name: "main", target: ["main-c"] }],
		});
		const { action } = fold({ jj: fakes });

		const result = await action({
			rev: "feat",
			onto: "main",
			named: "review/feat",
			land: true,
			exclude: [".scratch/"],
		});

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.bookmark).toBe("review/feat");
		expect(fakes.apply).toHaveBeenCalledWith({
			kind: "bookmarkSet",
			name: "review/feat",
			rev: "folded",
		});
		expect(fakes.apply).toHaveBeenCalledWith({
			kind: "bookmarkSet",
			name: "main",
			rev: "folded",
		});
		const squash = fakes.apply.mock.calls.find(
			(c) => (c[0] as { kind: string }).kind === "squash",
		)?.[0] as { filesets?: readonly string[] };
		expect(squash.filesets).toEqual(['~(prefix-glob:".scratch/")']);
	});

	it("keys the marker by the target's local bookmark, not the source's", async () => {
		const fakes = makeJj({
			bookmarks: [
				{ name: "feature", target: ["tip-c"] },
				{ name: "main", target: ["main-c"] },
			],
		});
		const { action } = fold({ jj: fakes });

		await action({ rev: "feat", onto: "main" });

		const set = fakes.apply.mock.calls
			.map((c) => c[0] as { kind: string; name?: string })
			.find((mutation) => mutation.kind === "bookmarkSet");
		expect(set?.name).toBe("sillajje/folded/main");
	});

	it("slugs the target rev when no bookmark points at it", async () => {
		const fakes = makeJj({ bookmarks: [] });
		const { action } = fold({ jj: fakes });

		await action({ rev: "feat", onto: "main" });

		const set = fakes.apply.mock.calls
			.map((c) => c[0] as { kind: string; name?: string })
			.find((mutation) => mutation.kind === "bookmarkSet");
		expect(set?.name).toBe("sillajje/folded/main");
	});

	it("rolls back and reports a conflict with its files", async () => {
		const fakes = makeJj({ conflicts: ["file.txt"] });
		const { action, statuses } = fold({ jj: fakes });

		const result = await action({ rev: "feat", onto: "main" });

		expect(result).toEqual({
			ok: false,
			reason: "conflict",
			files: ["file.txt"],
		});
		const warning = statuses.find(
			(s) => s.kind === "warning" && s.code === "conflict",
		);
		expect(warning).toBeDefined();
		if (warning?.kind === "warning") {
			expect(warning.message).toContain("file.txt");
		}
	});

	it("returns no-changes for an empty delta without a transaction", async () => {
		const fakes = makeJj({ delta: [] });
		const { action } = fold({ jj: fakes });

		const result = await action({ rev: "feat", onto: "main" });

		expect(result).toEqual({ ok: false, reason: "no-changes" });
		expect(fakes.transaction).not.toHaveBeenCalled();
	});

	it("resolves a session source through the Workspaces port", async () => {
		const fakes = makeJj();
		const resolve = vi.fn().mockResolvedValue({
			ok: true,
			sessionKey: "owner/s1",
			wsPath: "/ws",
		});
		const { action } = fold({ jj: fakes, resolve });

		const result = await action({
			session: "@",
			current: CURRENT,
			onto: "main",
		});

		expect(result.ok).toBe(true);
		expect(resolve).toHaveBeenCalledWith("owner/s1", CURRENT);
	});

	it("returns a session failure without a transaction", async () => {
		const fakes = makeJj();
		const { action } = fold({
			jj: fakes,
			resolve: async () => ({ ok: false, reason: "not-a-session" }),
		});

		const result = await action({ session: "ghost", onto: "main" });

		expect(result).toEqual({ ok: false, reason: "not-a-session" });
		expect(fakes.transaction).not.toHaveBeenCalled();
	});

	it("uses the Folded source marker as the base and advances the review bookmark with --update", async () => {
		const fakes = makeJj({
			bookmarks: [{ name: "sillajje/folded/main", target: ["prev-c"] }],
		});
		const { action } = fold({ jj: fakes });

		const result = await action({ rev: "feat", update: "main" });

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.bookmark).toBe("main");
		const duplicate = fakes.apply.mock.calls.find(
			(c) => (c[0] as { kind: string }).kind === "duplicate",
		)?.[0] as { revset: string };
		expect(duplicate.revset).toBe("prev-c..tip-c");
		// The review bookmark advances, and the source tip is recorded.
		expect(fakes.apply).toHaveBeenCalledWith({
			kind: "bookmarkSet",
			name: "main",
			rev: "folded",
		});
		expect(fakes.apply).toHaveBeenCalledWith({
			kind: "bookmarkSet",
			name: "sillajje/folded/main",
			rev: "tip",
		});
	});

	it("ignores a Folded source marker whose tip is not an ancestor of the source", async () => {
		await expectUpdateFallsBack([
			{ name: "sillajje/folded/main", target: ["main-c"] },
		]);
	});

	it("does not read a legacy two-part marker for --update", async () => {
		await expectUpdateFallsBack([
			{ name: "sillajje/folded/feat/main", target: ["prev-c"] },
		]);
	});

	it("ignores a conflicted Folded source marker and falls back", async () => {
		await expectUpdateFallsBack([
			{ name: "sillajje/folded/main", target: ["prev-c", "tip-c"] },
		]);
	});

	it("falls back when the Folded source marker resolves to no commit", async () => {
		await expectUpdateFallsBack(
			[{ name: "sillajje/folded/main", target: ["ghost-c"] }],
			{ logEmptyFor: ["ghost-c"] },
		);
	});

	it("ignores the Folded source marker without --update", async () => {
		const fakes = makeJj({
			bookmarks: [{ name: "sillajje/folded/main", target: ["prev-c"] }],
		});
		const { action } = fold({ jj: fakes });

		const result = await action({ rev: "feat", onto: "main" });

		expect(result.ok).toBe(true);
		const duplicate = fakes.apply.mock.calls.find(
			(c) => (c[0] as { kind: string }).kind === "duplicate",
		)?.[0] as { revset: string };
		expect(duplicate.revset).toBe("base-c..tip-c");
	});

	it("--update falls back to the fork point with no marker", async () => {
		await expectUpdateFallsBack([]);
	});

	it("--named sets a review bookmark and keys the marker by it", async () => {
		const fakes = makeJj();
		const { action } = fold({ jj: fakes });

		const result = await action({
			rev: "feat",
			onto: "main",
			named: "review/feat",
		});

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.bookmark).toBe("review/feat");
		expect(fakes.apply).toHaveBeenCalledWith({
			kind: "bookmarkSet",
			name: "review/feat",
			rev: "folded",
		});
		expect(fakes.apply).toHaveBeenCalledWith({
			kind: "bookmarkSet",
			name: "sillajje/folded/review/feat",
			rev: "tip",
		});
	});

	it("--named with an empty value auto-names fold-<change id>", async () => {
		const fakes = makeJj();
		const { action } = fold({ jj: fakes });

		const result = await action({ rev: "feat", onto: "main", named: "" });

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.bookmark).toBe("fold-folded");
		expect(fakes.apply).toHaveBeenCalledWith({
			kind: "bookmarkSet",
			name: "fold-folded",
			rev: "folded",
		});
	});

	it("rejects --update combined with -o", async () => {
		const fakes = makeJj();
		const { action } = fold({ jj: fakes });

		const result = await action({
			rev: "feat",
			onto: "main",
			update: "main",
		});

		expect(result).toEqual({
			ok: false,
			reason: "usage",
			message: expect.stringContaining("--update"),
		});
		expect(fakes.transaction).not.toHaveBeenCalled();
	});

	it("advances the target's single local bookmark with --land", async () => {
		const fakes = makeJj({
			bookmarks: [{ name: "main", target: ["main-c"] }],
		});
		const { action } = fold({ jj: fakes });

		const result = await action({ rev: "feat", onto: "main", land: true });

		expect(result.ok).toBe(true);
		expect(fakes.apply).toHaveBeenCalledWith({
			kind: "bookmarkSet",
			name: "main",
			rev: "folded",
		});
	});

	it("--push pushes the updated bookmark to every tracking remote", async () => {
		const fakes = makeJj({
			bookmarks: [
				{ name: "main", target: ["main-c"] },
				{ name: "main", remote: "git", target: ["main-c"] },
				{ name: "main", remote: "origin", target: ["main-c"] },
				{ name: "main", remote: "upstream", target: ["main-c"] },
			],
		});
		const { action } = fold({ jj: fakes });

		const result = await action({
			rev: "feat",
			update: "main",
			push: true,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.pushed).toEqual(["main@origin", "main@upstream"]);
		}
		expect(fakes.gitPush).toHaveBeenCalledWith(
			{ bookmark: "main", remote: "origin" },
			{ cwd: "." },
		);
		expect(fakes.gitPush).toHaveBeenCalledWith(
			{ bookmark: "main", remote: "upstream" },
			{ cwd: "." },
		);
	});

	it("--push uses jj's default remote for an untracked bookmark", async () => {
		const fakes = makeJj({
			bookmarks: [{ name: "main", target: ["main-c"] }],
		});
		const { action } = fold({ jj: fakes });

		const result = await action({
			rev: "feat",
			update: "main",
			push: true,
		});

		expect(fakes.gitPush).toHaveBeenCalledWith(
			{ bookmark: "main" },
			{ cwd: "." },
		);
		if (result.ok) expect(result.pushed).toEqual(["main"]);
	});

	it("--push with --land pushes the landed bookmark", async () => {
		const fakes = makeJj({
			bookmarks: [{ name: "main", target: ["main-c"] }],
		});
		const { action } = fold({ jj: fakes });

		const result = await action({
			rev: "feat",
			onto: "main",
			land: true,
			push: true,
		});

		expect(result.ok).toBe(true);
		expect(fakes.gitPush).toHaveBeenCalledWith(
			{ bookmark: "main" },
			{ cwd: "." },
		);
	});

	it("a failed push warns and leaves the fold successful", async () => {
		const fakes = makeJj({
			bookmarks: [{ name: "main", remote: "origin", target: ["main-c"] }],
		});
		fakes.gitPush.mockRejectedValueOnce(new Error("network down"));
		const { action, statuses } = fold({ jj: fakes });

		const result = await action({
			rev: "feat",
			update: "main",
			push: true,
		});

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.pushed).toEqual([]);
		expect(statuses).toContainEqual(
			expect.objectContaining({ kind: "warning", code: "push_failed" }),
		);
	});

	it("rejects --push without --update or --land", async () => {
		const fakes = makeJj();
		const { action } = fold({ jj: fakes });

		const result = await action({
			rev: "feat",
			onto: "main",
			push: true,
		});

		expect(result).toEqual({
			ok: false,
			reason: "usage",
			message: expect.stringContaining("--push"),
		});
		expect(fakes.transaction).not.toHaveBeenCalled();
	});

	it("rejects --land when --onto matches more than one local bookmark", async () => {
		const fakes = makeJj({
			bookmarks: [
				{ name: "main", target: ["main-c"] },
				{ name: "trunk", target: ["main-c"] },
			],
		});
		const { action } = fold({ jj: fakes });

		const result = await action({ rev: "feat", onto: "main", land: true });

		expect(result).toEqual({
			ok: false,
			reason: "usage",
			message: expect.stringContaining("exactly one local bookmark"),
		});
		expect(fakes.transaction).not.toHaveBeenCalled();
	});

	it("archives a session source with --archive", async () => {
		const fakes = makeJj();
		const archive = vi.fn(async () => ({ status: "removed" as const }));
		const { action } = fold({ jj: fakes, archive });

		const result = await action({
			session: "@",
			current: CURRENT,
			onto: "main",
			archive: true,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.archived).toBe(true);
			expect(result.sessionKey).toBe("owner/s1");
		}
		expect(archive).toHaveBeenCalledWith("owner/s1");
	});

	it("rejects --archive with a rev source", async () => {
		const fakes = makeJj();
		const { action } = fold({ jj: fakes });

		const result = await action({
			rev: "feat",
			onto: "main",
			archive: true,
		});

		expect(result).toEqual({
			ok: false,
			reason: "usage",
			message: "--archive requires a session source",
		});
		expect(fakes.transaction).not.toHaveBeenCalled();
	});

	it("reports a failed archive without undoing the fold", async () => {
		const fakes = makeJj();
		const archive = vi.fn(async () => ({
			status: "failed" as const,
			reason: "boom",
		}));
		const { action, statuses } = fold({ jj: fakes, archive });

		const result = await action({
			session: "@",
			current: CURRENT,
			onto: "main",
			archive: true,
		});

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.archived).toBe(false);
		expect(
			statuses.some(
				(s) => s.kind === "warning" && s.code === "archive_failed",
			),
		).toBe(true);
	});
});
