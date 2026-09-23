/**
 * The sync action's seam: build it with fake ports and a recording sink, then
 * assert the result, the status stream, and the jj mutations.
 */

import type { Jj, JjFailure } from "@pi-tre/sillajje-jj";
import type {
	CurrentSession,
	SessionTargetResolution,
	Workspaces,
} from "@pi-tre/sillajje-workspace";
import { describe, expect, it, vi } from "vitest";
import {
	createSync,
	parseCommandArgs,
	renderHelp,
	type StatusEvent,
	SYNC_ARGS,
	SYNC_HELP,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeJj() {
	const apply = vi.fn().mockResolvedValue({
		ok: true,
		value: { op: "op-1", created: [] },
	});
	const conflicts = vi.fn().mockResolvedValue([]);
	const workspaceUpdateStale = vi.fn().mockResolvedValue(undefined);
	const jj = {
		apply,
		conflicts,
		workspaceUpdateStale,
	} as unknown as Jj;
	return { jj, apply, conflicts, workspaceUpdateStale };
}

function makeWorkspaces(
	resolve: (
		target: string,
		current: CurrentSession,
	) => Promise<SessionTargetResolution>,
): Workspaces {
	return {
		sessionKey: (target: string) =>
			target.includes("/") ? target : `owner/${target}`,
		bookmarkName: (key: string) => `sillajje/${key}`,
		resolveTarget: resolve,
	} as unknown as Workspaces;
}

function collectingSink(): {
	onStatus: (event: StatusEvent) => void;
	statuses: StatusEvent[];
} {
	const statuses: StatusEvent[] = [];
	return { onStatus: (event) => statuses.push(event), statuses };
}

const REBASE_FAILURE: JjFailure = {
	kind: "command",
	mutation: { kind: "rebase", source: "@", onto: ["main"] },
	exitCode: 1,
	stderr: "boom",
};

const CURRENT: CurrentSession = { sessionKey: "owner/s1", wsPath: "/ws" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSync", () => {
	it("syncs the current session with a two-parent rebase", async () => {
		const { jj, apply } = makeJj();
		const workspaces = makeWorkspaces(async () => ({
			ok: true,
			sessionKey: "owner/s1",
			wsPath: "/ws",
		}));
		const { onStatus, statuses } = collectingSink();

		const sync = createSync({ jj, workspaces, onStatus });
		const result = await sync({
			target: "@",
			current: CURRENT,
			rev: "main",
		});

		expect(result).toEqual({
			ok: true,
			rev: "main",
			sessionKey: "owner/s1",
		});
		expect(apply).toHaveBeenCalledWith(
			{
				kind: "rebase",
				source: "@",
				onto: ["main", "sillajje/owner/s1"],
			},
			{ cwd: "/ws" },
		);
		expect(statuses).toEqual([{ kind: "phase", code: "rebasing" }]);
	});

	it("resolves a named session through the Workspaces port", async () => {
		const { jj } = makeJj();
		const resolve = vi.fn().mockResolvedValue({
			ok: true,
			sessionKey: "owner/other",
			wsPath: "/ws-other",
		});
		const { onStatus } = collectingSink();

		const sync = createSync({
			jj,
			workspaces: makeWorkspaces(resolve),
			onStatus,
		});
		const result = await sync({
			target: "other",
			current: CURRENT,
			rev: "main",
		});

		expect(result).toEqual({
			ok: true,
			rev: "main",
			sessionKey: "owner/other",
		});
		expect(resolve).toHaveBeenCalledWith("other", CURRENT);
	});

	it("returns the session failure without touching jj", async () => {
		const { jj, apply } = makeJj();
		const workspaces = makeWorkspaces(async () => ({
			ok: false,
			reason: "archived",
		}));
		const { onStatus } = collectingSink();

		const sync = createSync({ jj, workspaces, onStatus });
		const result = await sync({
			target: "@",
			current: CURRENT,
			rev: "main",
		});

		expect(result).toEqual({ ok: false, reason: "archived" });
		expect(apply).not.toHaveBeenCalled();
	});

	it("emits an error and fails when the rebase fails", async () => {
		const { jj, conflicts } = makeJj();
		jj.apply = vi.fn().mockResolvedValue({
			ok: false,
			error: REBASE_FAILURE,
		});
		const workspaces = makeWorkspaces(async () => ({
			ok: true,
			sessionKey: "owner/s1",
			wsPath: "/ws",
		}));
		const { onStatus, statuses } = collectingSink();

		const sync = createSync({ jj, workspaces, onStatus });
		const result = await sync({
			target: "@",
			current: CURRENT,
			rev: "main",
		});

		expect(result).toEqual({ ok: false, reason: "failed" });
		expect(
			statuses.some(
				(s) => s.kind === "error" && s.code === "rebase_failed",
			),
		).toBe(true);
		expect(conflicts).not.toHaveBeenCalled();
	});

	it("aborts with the conflicting files and no success", async () => {
		const { jj } = makeJj();
		jj.conflicts = vi.fn().mockResolvedValue(["file.txt"]);
		const workspaces = makeWorkspaces(async () => ({
			ok: true,
			sessionKey: "owner/s1",
			wsPath: "/ws",
		}));
		const { onStatus, statuses } = collectingSink();

		const sync = createSync({ jj, workspaces, onStatus });
		const result = await sync({
			target: "@",
			current: CURRENT,
			rev: "main",
		});

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

	it("warns but succeeds when update-stale fails", async () => {
		const { jj } = makeJj();
		jj.workspaceUpdateStale = vi.fn().mockRejectedValue(new Error("stale"));
		const workspaces = makeWorkspaces(async () => ({
			ok: true,
			sessionKey: "owner/s1",
			wsPath: "/ws",
		}));
		const { onStatus, statuses } = collectingSink();

		const sync = createSync({ jj, workspaces, onStatus });
		const result = await sync({
			target: "@",
			current: CURRENT,
			rev: "main",
		});

		expect(result).toEqual({
			ok: true,
			rev: "main",
			sessionKey: "owner/s1",
		});
		expect(
			statuses.some(
				(s) => s.kind === "warning" && s.code === "update_stale_failed",
			),
		).toBe(true);
	});
});

describe("SYNC_ARGS", () => {
	it("requires --onto", () => {
		const result = parseCommandArgs("-s @", SYNC_ARGS);
		expect(result.kind).toBe("error");
		if (result.kind === "error") {
			expect(result.message).toContain("--onto");
		}
	});

	it("defaults the session and parses --onto", () => {
		expect(parseCommandArgs("-o main", SYNC_ARGS)).toEqual({
			kind: "go",
			values: { onto: "main" },
		});
	});

	it("returns help for a target-less invocation", () => {
		expect(parseCommandArgs("", SYNC_ARGS)).toEqual({ kind: "help" });
	});

	it("renders its usage line with the caller's prefix", () => {
		expect(renderHelp(SYNC_HELP, "/sillajje:")).toContain(
			"usage: /sillajje:sync",
		);
	});
});
