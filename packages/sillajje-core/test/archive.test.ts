/**
 * The archive action family's seam: build each action with fake ports and a
 * recording sink, then assert the result, the status stream, and which port
 * call the action made.
 */

import type { CurrentSession, Workspaces } from "@pi-tre/sillajje-workspace";
import { describe, expect, it, vi } from "vitest";
import {
	ARCHIVE_ARGS,
	createArchive,
	createUnarchive,
	parseCommandArgs,
	renderHelp,
	type StatusEvent,
	UNARCHIVE_ARGS,
	UNARCHIVE_HELP,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const OWNER = "owner/host";
const WORKSPACE = {
	sessionKey: "owner/host/s1",
	workspaceName: "sillajje/owner/host/s1",
	workspacePath: "/ws/s1",
};

function makeWorkspaces(overrides: Partial<Workspaces> = {}): Workspaces {
	return {
		owner: OWNER,
		sessionKey: (target: string) =>
			target.includes("/") ? target : `${OWNER}/${target}`,
		ownerOf: (key: string) => key.split("/").slice(0, 2).join("/"),
		unqualified: (key: string) => key.split("/").slice(2).join("/"),
		isLive: vi.fn().mockResolvedValue(false),
		archive: vi.fn().mockResolvedValue({ status: "removed" }),
		unarchive: vi.fn().mockResolvedValue(WORKSPACE),
		...overrides,
	} as unknown as Workspaces;
}

function collectingSink(): {
	onStatus: (event: StatusEvent) => void;
	statuses: StatusEvent[];
} {
	const statuses: StatusEvent[] = [];
	return { onStatus: (event) => statuses.push(event), statuses };
}

const CURRENT: CurrentSession = { sessionKey: "owner/host/s1", wsPath: "/ws" };

// ---------------------------------------------------------------------------
// createArchive
// ---------------------------------------------------------------------------

describe("createArchive", () => {
	it("resolves @ to the caller's session and archives it", async () => {
		const workspaces = makeWorkspaces();
		const { onStatus, statuses } = collectingSink();

		const result = await createArchive({ workspaces, onStatus })({
			target: "@",
			current: CURRENT,
		});

		expect(result).toEqual({
			ok: true,
			sessionKey: "owner/host/s1",
			status: "removed",
		});
		expect(workspaces.archive).toHaveBeenCalledWith("owner/host/s1");
		expect(statuses).toEqual([{ kind: "phase", code: "archiving" }]);
	});

	it("qualifies a named session id", async () => {
		const workspaces = makeWorkspaces();
		const { onStatus } = collectingSink();

		const result = await createArchive({ workspaces, onStatus })({
			target: "other",
			current: CURRENT,
		});

		expect(result).toEqual({
			ok: true,
			sessionKey: "owner/host/other",
			status: "removed",
		});
		expect(workspaces.archive).toHaveBeenCalledWith("owner/host/other");
	});

	it("reports an already-gone workspace as success", async () => {
		const workspaces = makeWorkspaces({
			archive: vi.fn().mockResolvedValue({ status: "already-gone" }),
		} as Partial<Workspaces>);
		const { onStatus } = collectingSink();

		const result = await createArchive({ workspaces, onStatus })({
			target: "@",
			current: CURRENT,
		});

		expect(result).toEqual({
			ok: true,
			sessionKey: "owner/host/s1",
			status: "already-gone",
		});
	});

	it("rejects a foreign session without touching the port", async () => {
		const workspaces = makeWorkspaces();
		const { onStatus } = collectingSink();

		const result = await createArchive({ workspaces, onStatus })({
			target: "foreign/owner/s1",
			current: CURRENT,
		});

		expect(result).toEqual({ ok: false, reason: "foreign" });
		expect(workspaces.archive).not.toHaveBeenCalled();
	});

	it("rejects a path-traversal session id before the port", async () => {
		const workspaces = makeWorkspaces();
		const { onStatus } = collectingSink();

		const result = await createArchive({ workspaces, onStatus })({
			target: "owner/host/../../victim",
			current: CURRENT,
		});

		expect(result).toEqual({ ok: false, reason: "not-a-session" });
		expect(workspaces.archive).not.toHaveBeenCalled();
	});

	it("rejects @ when the caller has no session", async () => {
		const workspaces = makeWorkspaces();
		const { onStatus } = collectingSink();

		const result = await createArchive({ workspaces, onStatus })({
			target: "@",
			current: {},
		});

		expect(result).toEqual({ ok: false, reason: "not-a-session" });
		expect(workspaces.archive).not.toHaveBeenCalled();
	});

	it("emits an error and fails when the port fails", async () => {
		const workspaces = makeWorkspaces({
			archive: vi
				.fn()
				.mockResolvedValue({ status: "failed", reason: "boom" }),
		} as Partial<Workspaces>);
		const { onStatus, statuses } = collectingSink();

		const result = await createArchive({ workspaces, onStatus })({
			target: "@",
			current: CURRENT,
		});

		expect(result).toEqual({
			ok: false,
			reason: "failed",
			message: "boom",
		});
		expect(
			statuses.some(
				(s) => s.kind === "error" && s.code === "archive_failed",
			),
		).toBe(true);
	});

	it("emits an error and fails when the port throws", async () => {
		const workspaces = makeWorkspaces({
			archive: vi.fn().mockRejectedValue(new Error("boom")),
		} as Partial<Workspaces>);
		const { onStatus, statuses } = collectingSink();

		const result = await createArchive({ workspaces, onStatus })({
			target: "@",
			current: CURRENT,
		});

		expect(result).toEqual({
			ok: false,
			reason: "failed",
			message: "boom",
		});
		expect(
			statuses.some(
				(s) => s.kind === "error" && s.code === "archive_failed",
			),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// createUnarchive
// ---------------------------------------------------------------------------

describe("createUnarchive", () => {
	it("resolves @ and restores the session's workspace", async () => {
		const workspaces = makeWorkspaces();
		const { onStatus, statuses } = collectingSink();

		const result = await createUnarchive({ workspaces, onStatus })({
			target: "@",
			current: CURRENT,
		});

		expect(result).toEqual({
			ok: true,
			sessionKey: "owner/host/s1",
			sessionId: "s1",
			workspace: WORKSPACE,
		});
		expect(workspaces.unarchive).toHaveBeenCalledWith("owner/host/s1");
		expect(statuses).toEqual([{ kind: "phase", code: "unarchiving" }]);
	});

	it("rejects a foreign session without touching the port", async () => {
		const workspaces = makeWorkspaces();
		const { onStatus } = collectingSink();

		const result = await createUnarchive({ workspaces, onStatus })({
			target: "foreign/owner/s1",
			current: CURRENT,
		});

		expect(result).toEqual({ ok: false, reason: "foreign" });
		expect(workspaces.unarchive).not.toHaveBeenCalled();
	});

	it("rejects an already-live session without unarchiving", async () => {
		const workspaces = makeWorkspaces({
			isLive: vi.fn().mockResolvedValue(true),
		} as Partial<Workspaces>);
		const { onStatus } = collectingSink();

		const result = await createUnarchive({ workspaces, onStatus })({
			target: "@",
			current: CURRENT,
		});

		expect(result).toEqual({
			ok: false,
			reason: "active",
			sessionKey: "owner/host/s1",
		});
		expect(workspaces.unarchive).not.toHaveBeenCalled();
	});

	it("unarchives a registered-but-gone workspace", async () => {
		// `isLive` is false: jj still lists the name, but the directory is gone.
		const workspaces = makeWorkspaces();
		const { onStatus } = collectingSink();

		const result = await createUnarchive({ workspaces, onStatus })({
			target: "@",
			current: CURRENT,
		});

		expect(result.ok).toBe(true);
		expect(workspaces.unarchive).toHaveBeenCalledWith("owner/host/s1");
	});

	it("rejects a path-traversal session id before the port", async () => {
		const workspaces = makeWorkspaces();
		const { onStatus } = collectingSink();

		const result = await createUnarchive({ workspaces, onStatus })({
			target: "owner/host/../../victim",
			current: CURRENT,
		});

		expect(result).toEqual({ ok: false, reason: "not-a-session" });
		expect(workspaces.unarchive).not.toHaveBeenCalled();
	});

	it("rejects @ when the caller has no session", async () => {
		const workspaces = makeWorkspaces();
		const { onStatus } = collectingSink();

		const result = await createUnarchive({ workspaces, onStatus })({
			target: "@",
			current: {},
		});

		expect(result).toEqual({ ok: false, reason: "not-a-session" });
		expect(workspaces.unarchive).not.toHaveBeenCalled();
	});

	it("emits an error and fails when the port throws", async () => {
		const workspaces = makeWorkspaces({
			unarchive: vi.fn().mockRejectedValue(new Error("boom")),
		} as Partial<Workspaces>);
		const { onStatus, statuses } = collectingSink();

		const result = await createUnarchive({ workspaces, onStatus })({
			target: "@",
			current: CURRENT,
		});

		expect(result).toEqual({
			ok: false,
			reason: "failed",
			message: "boom",
		});
		expect(
			statuses.some(
				(s) => s.kind === "error" && s.code === "unarchive_failed",
			),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Argument specs
// ---------------------------------------------------------------------------

describe("archive argument specs", () => {
	it("treats a target-less archive and unarchive as help", () => {
		expect(parseCommandArgs("", ARCHIVE_ARGS)).toEqual({ kind: "help" });
		expect(parseCommandArgs("", UNARCHIVE_ARGS)).toEqual({ kind: "help" });
	});

	it("parses --session for both subcommands", () => {
		expect(parseCommandArgs("-s @", ARCHIVE_ARGS)).toEqual({
			kind: "go",
			values: { session: "@" },
		});
		expect(parseCommandArgs("--session other", UNARCHIVE_ARGS)).toEqual({
			kind: "go",
			values: { session: "other" },
		});
	});

	it("renders the unarchive usage line with the caller's prefix", () => {
		expect(renderHelp(UNARCHIVE_HELP, "/sillajje:")).toContain(
			"usage: /sillajje:unarchive",
		);
	});
});
