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
	parents: ["base-c"],
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

interface Fakes {
	jj: Jj;
	log: ReturnType<typeof vi.fn>;
	apply: ReturnType<typeof vi.fn>;
	conflicts: ReturnType<typeof vi.fn>;
	bookmarks: ReturnType<typeof vi.fn>;
	gitPush: ReturnType<typeof vi.fn>;
	transaction: ReturnType<typeof vi.fn>;
}

function makeJj(opts?: {
	delta?: Commit[];
	conflicts?: string[];
	bookmarks?: Bookmark[];
}): Fakes {
	const delta = opts?.delta ?? [TIP];
	const log = vi.fn(async (revset: string) => {
		if (revset === "feat" || revset === "@") return [TIP];
		if (revset === "main") return [MAIN];
		if (revset === PREV.commitId) return [PREV];
		if (revset.startsWith("fork_point")) return [BASE];
		if (revset.startsWith("sillajje/")) return [TIP];
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
	const jj = {
		log,
		diff: vi.fn(async () => "diff --git a/f b/f\n+added"),
		diffRange: vi.fn(async () => "diff --git a/f b/f\n+added"),
		bookmarks,
		gitPush,
		transaction,
	} as unknown as Jj;
	return { jj, log, apply, conflicts, bookmarks, gitPush, transaction };
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
		expect(squash.message).not.toContain("Meta:");
		expect(squash.message).not.toContain("Loop:");

		expect(fakes.transaction).toHaveBeenCalledTimes(1);
		expect(statuses).toEqual([{ kind: "phase", code: "folding" }]);
	});

	it("names the folded-source bookmark after the rev's local bookmark", async () => {
		const fakes = makeJj({
			bookmarks: [{ name: "feature", target: ["tip-c"] }],
		});
		const { action } = fold({ jj: fakes });

		await action({ rev: "feat", onto: "main" });

		const set = fakes.apply.mock.calls
			.map((c) => c[0] as { kind: string; name?: string })
			.find((mutation) => mutation.kind === "bookmarkSet");
		expect(set?.name).toBe("sillajje/folded/feature/main");
	});

	it("slugs the rev string when no bookmark points at the tip", async () => {
		const fakes = makeJj({ bookmarks: [] });
		const { action } = fold({ jj: fakes });

		await action({ rev: "feat", onto: "main" });

		const set = fakes.apply.mock.calls
			.map((c) => c[0] as { kind: string; name?: string })
			.find((mutation) => mutation.kind === "bookmarkSet");
		expect(set?.name).toBe("sillajje/folded/feat/main");
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

	it("uses the recorded marker as the base and advances the review bookmark with --update", async () => {
		const fakes = makeJj({
			bookmarks: [
				{ name: "sillajje/folded/feat/main", target: ["prev-c"] },
			],
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
			name: "sillajje/folded/feat/main",
			rev: "tip",
		});
	});

	it("ignores the recorded marker without --update", async () => {
		const fakes = makeJj({
			bookmarks: [
				{ name: "sillajje/folded/feat/main", target: ["prev-c"] },
			],
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
		const fakes = makeJj({ bookmarks: [] });
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
			name: "sillajje/folded/feat/review/feat",
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
