import { describe, expect, it } from "vitest";
import { createWorkspaces } from "../src/index.js";
import { type FakeJjState, fakeJj } from "./helpers.js";

const OWNER = "alice/laptop";

function binding(state: Partial<FakeJjState>) {
	const fake = fakeJj(state);
	return {
		ws: createWorkspaces(fake.jj, {
			repoRoot: "/repo",
			workspacesRoot: "/ws-root",
			owner: OWNER,
		}),
		state: fake.state,
	};
}

const bookmark = (key: string) => ({ name: `sillajje/${key}`, target: ["x"] });
const workspace = (key: string, root: string) => ({
	name: `sillajje/${key}`,
	root,
});

describe("resolveTarget", () => {
	it("trusts the current session without touching jj", async () => {
		const { ws, state } = binding({});

		const target = await ws.resolveTarget("abc", {
			sessionKey: "alice/laptop/abc",
			wsPath: "/ws/abc",
		});

		expect(target).toEqual({
			ok: true,
			sessionKey: "alice/laptop/abc",
			wsPath: "/ws/abc",
		});
		expect(state.reads).toEqual([]);
	});

	it("resolves another active session in the current owner namespace", async () => {
		const { ws } = binding({
			workspaces: [workspace("alice/laptop/other", "/ws/other")],
		});

		const target = await ws.resolveTarget("other", { sessionKey: "abc" });

		expect(target).toEqual({
			ok: true,
			sessionKey: "alice/laptop/other",
			wsPath: "/ws/other",
		});
	});

	it("reports not-a-session when no bookmark exists", async () => {
		const { ws } = binding({
			bookmarks: [bookmark("main")],
		});

		const target = await ws.resolveTarget("ghost", {});

		expect(target).toEqual({ ok: false, reason: "not-a-session" });
	});

	it("reports archived when the owner's bookmark has no workspace", async () => {
		const { ws } = binding({
			bookmarks: [bookmark("alice/laptop/gone")],
		});

		const target = await ws.resolveTarget("gone", {});

		expect(target).toEqual({ ok: false, reason: "archived" });
	});

	it("reports foreign when the bookmark belongs to another owner", async () => {
		const { ws } = binding({
			bookmarks: [bookmark("bob/desktop/other")],
		});

		const target = await ws.resolveTarget("bob/desktop/other", {});

		expect(target).toEqual({ ok: false, reason: "foreign" });
	});

	it("reports foreign when another owner's workspace is registered", async () => {
		const { ws } = binding({
			workspaces: [workspace("bob/desktop/other", "/ws/other")],
		});

		const target = await ws.resolveTarget("bob/desktop/other", {});

		expect(target).toEqual({ ok: false, reason: "foreign" });
	});

	it("does not let a suffixed bookmark satisfy a lookup", async () => {
		const { ws } = binding({
			bookmarks: [bookmark("alice/laptop/abc-2")],
		});

		const target = await ws.resolveTarget("abc", {});

		expect(target).toEqual({ ok: false, reason: "not-a-session" });
	});
});

describe("resolveBaseSource", () => {
	it("resolves an archived session to its bookmark", async () => {
		const { ws } = binding({
			bookmarks: [bookmark("alice/laptop/gone")],
		});

		await expect(ws.resolveBaseSource("gone")).resolves.toEqual({
			ok: true,
			sessionKey: "alice/laptop/gone",
			revision: "sillajje/alice/laptop/gone",
		});
	});

	it("resolves a live session to its bookmark", async () => {
		const { ws } = binding({
			bookmarks: [bookmark("alice/laptop/other")],
			workspaces: [workspace("alice/laptop/other", "/ws/other")],
		});

		await expect(ws.resolveBaseSource("other")).resolves.toEqual({
			ok: true,
			sessionKey: "alice/laptop/other",
			revision: "sillajje/alice/laptop/other",
		});
	});

	it("reports not-a-session when no bookmark exists", async () => {
		const { ws } = binding({});

		await expect(ws.resolveBaseSource("ghost")).resolves.toEqual({
			ok: false,
			reason: "not-a-session",
		});
	});

	it("reports foreign when the bookmark belongs to another owner", async () => {
		const { ws } = binding({
			bookmarks: [bookmark("bob/desktop/other")],
		});

		await expect(
			ws.resolveBaseSource("bob/desktop/other"),
		).resolves.toEqual({ ok: false, reason: "foreign" });
	});

	it("reports ambiguous when the bookmark has several targets", async () => {
		const { ws } = binding({
			bookmarks: [
				{
					name: "sillajje/alice/laptop/other",
					target: ["a", "b"],
				},
			],
		});

		await expect(ws.resolveBaseSource("other")).resolves.toEqual({
			ok: false,
			reason: "ambiguous",
		});
	});

	it("ignores a remote-tracking bookmark that shares the name", async () => {
		const { ws } = binding({
			bookmarks: [
				{
					name: "sillajje/alice/laptop/other",
					target: ["a"],
					remote: "git",
				},
			],
		});

		await expect(ws.resolveBaseSource("other")).resolves.toEqual({
			ok: false,
			reason: "not-a-session",
		});
	});
});
