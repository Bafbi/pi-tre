import { describe, expect, it, vi } from "vitest";

import {
	addDebugEvent,
	buildDebugDump,
	createDebugState,
	setDebugEnabled,
	setWorkspacePath,
	syncDebugUi,
	trackRepo,
} from "../../src/debug.js";

function makeUiCtx() {
	const statusCalls: Array<{ key: string; value: string | undefined }> = [];
	const widgetCalls: Array<{ key: string; lines: string[] | undefined }> = [];

	return {
		ctx: {
			hasUI: true,
			ui: {
				setStatus: (key: string, value: string | undefined) => {
					statusCalls.push({ key, value });
				},
				setWidget: (key: string, lines: string[] | undefined) => {
					widgetCalls.push({ key, lines });
				},
			},
		},
		statusCalls,
		widgetCalls,
	};
}

describe("createDebugState", () => {
	it("returns a fresh state with defaults", () => {
		const state = createDebugState();
		expect(state.enabled).toBe(false);
		expect(state.events).toEqual([]);
		expect(state.workspacePath).toBeNull();
		expect(state.trackedRepos.size).toBe(0);
	});
});

describe("addDebugEvent", () => {
	it("appends an event to the state", () => {
		const state = createDebugState();
		addDebugEvent(state, "test event");
		expect(state.events.length).toBe(1);
		expect(state.events[0]).toContain("test event");
	});

	it("truncates to the last 20 events", () => {
		const state = createDebugState();
		for (let i = 0; i < 25; i++) {
			addDebugEvent(state, `event ${i}`);
		}
		expect(state.events.length).toBe(20);
		expect(state.events[0]).toContain("event 5");
		expect(state.events[state.events.length - 1]).toContain("event 24");
	});

	it("syncs UI when debug is enabled and ctx is provided", () => {
		const state = createDebugState();
		const { ctx, statusCalls, widgetCalls } = makeUiCtx();
		setDebugEnabled(state, true, ctx);

		addDebugEvent(state, "ui event", ctx);

		expect(statusCalls.length).toBeGreaterThan(0);
		expect(widgetCalls.length).toBeGreaterThan(0);
	});

	it("does not sync UI when debug is disabled", () => {
		const state = createDebugState();
		const { ctx, statusCalls, widgetCalls } = makeUiCtx();

		addDebugEvent(state, "quiet event", ctx);

		expect(statusCalls).toHaveLength(0);
		expect(widgetCalls).toHaveLength(0);
	});
});

describe("setDebugEnabled", () => {
	it("toggles the enabled flag", () => {
		const state = createDebugState();
		setDebugEnabled(state, true);
		expect(state.enabled).toBe(true);
		setDebugEnabled(state, false);
		expect(state.enabled).toBe(false);
	});

	it("clears UI widgets when disabled", () => {
		const state = createDebugState();
		const { ctx, widgetCalls } = makeUiCtx();

		setDebugEnabled(state, true, ctx);
		expect(widgetCalls.some((c) => c.lines !== undefined)).toBe(true);

		setDebugEnabled(state, false, ctx);
		expect(widgetCalls[widgetCalls.length - 1]).toEqual({
			key: "repo-query-debug",
			lines: undefined,
		});
	});
});

describe("trackRepo", () => {
	it("records repo status and branch", () => {
		const state = createDebugState();
		trackRepo(state, "owner/repo", {
			status: "cloned",
			cloned: true,
			branch: "main",
		});

		const info = state.trackedRepos.get("owner/repo");
		expect(info).toEqual({
			status: "cloned",
			cloned: true,
			branch: "main",
		});
	});

	it("overwrites existing entries", () => {
		const state = createDebugState();
		trackRepo(state, "owner/repo", { status: "parsed", cloned: false });
		trackRepo(state, "owner/repo", { status: "cloned", cloned: true });

		expect(state.trackedRepos.get("owner/repo")?.status).toBe("cloned");
	});
});

describe("setWorkspacePath", () => {
	it("sets the workspace path on state", () => {
		const state = createDebugState();
		setWorkspacePath(state, "/tmp/workspace");
		expect(state.workspacePath).toBe("/tmp/workspace");
	});
});

describe("buildDebugDump", () => {
	it("includes runtime, session, tracked repos, and recent events", () => {
		const state = createDebugState();
		setDebugEnabled(state, true);
		setWorkspacePath(state, "/tmp/ws");
		trackRepo(state, "a/b", { status: "cloned", cloned: true });
		addDebugEvent(state, "event one");

		const dump = buildDebugDump(state, {
			cwd: "/project",
			sessionManager: {
				getSessionFile: () => "/tmp/session.json",
				getLeafId: () => "leaf-1",
				getBranch: () => [{ type: "message" }],
				getEntries: () => [{ type: "message" }],
			},
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext);

		expect(dump).toContain("repo-query debug dump");
		expect(dump).toContain("debugEnabled: true");
		expect(dump).toContain("workspacePath: /tmp/ws");
		expect(dump).toContain("a/b");
		expect(dump).toContain("event one");
		expect(dump).toContain("sessionFile: /tmp/session.json");
		expect(dump).toContain("leafId: leaf-1");
	});

	it("shows placeholder when no repos are tracked", () => {
		const state = createDebugState();
		const dump = buildDebugDump(state, {
			cwd: "/project",
			sessionManager: {
				getSessionFile: () => null,
				getLeafId: () => null,
				getBranch: () => [],
				getEntries: () => [],
			},
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext);

		expect(dump).toContain("(no tracked repos yet)");
	});
});

describe("syncDebugUi", () => {
	it("does nothing when hasUI is false", () => {
		const state = createDebugState();
		const ctx = {
			hasUI: false,
			ui: { setStatus: vi.fn(), setWidget: vi.fn() },
		};
		syncDebugUi(state, ctx);
		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
		expect(ctx.ui.setWidget).not.toHaveBeenCalled();
	});

	it("shows tracked repos and recent events in widget", () => {
		const state = createDebugState();
		setDebugEnabled(state, true);
		trackRepo(state, "foo/bar", { status: "success", cloned: true });
		addDebugEvent(state, "something happened");

		const { ctx, widgetCalls } = makeUiCtx();
		syncDebugUi(state, ctx);

		const lastWidget = widgetCalls[widgetCalls.length - 1];
		expect(lastWidget.lines).toBeDefined();
		expect(lastWidget.lines?.some((l) => l.includes("foo/bar"))).toBe(true);
		expect(
			lastWidget.lines?.some((l) => l.includes("something happened")),
		).toBe(true);
	});
});
