/**
 * Integration tests for cross-session stamping (`/sillajje:stamp -s <id>`)
 * against real jj, driven through the registered command.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import {
	assistantMsg,
	createRunner,
	describeJj,
	getSessionId,
	initRepo,
	installDefaultSubGeneratorMock,
	jj,
	recordAssistantMessage,
	recordUserMessage,
	runSillajje,
	sessionBookmark,
	wsPath,
} from "./_helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a foreign sillajje session by hand: a workspace off `@-`, content
 * in its working copy, and the `sillajje/<id>` bookmark pointing at `@`.
 */
function makeForeignSession(cwd: string, id: string): string {
	const path = join(cwd, `ws-${id}`);
	jj(
		[
			"workspace",
			"add",
			"--name",
			sessionBookmark(id),
			"--revision",
			"@-",
			path,
		],
		cwd,
	);
	writeFileSync(join(path, "other.txt"), "// other work\n");
	jj(["bookmark", "set", sessionBookmark(id), "-r", "@"], path);
	return path;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
	installDefaultSubGeneratorMock();
});

describeJj("sillajje cross-session stamp", () => {
	it("seals the named session's @ through its own workspace", async () => {
		const cwd = initRepo();
		const otherId = "other-1";
		const otherPath = makeForeignSession(cwd, otherId);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);

		await runSillajje(runner, `stamp -s ${otherId}`);

		// The foreign session's @ is described, with the stamped session's
		// key in the provenance — not the issuer's. The seal's `jj new`
		// advances the foreign @, so the described change sits at @-.
		const atDesc = jj(
			["log", "-r", "@-", "--no-graph", "-T", "description"],
			otherPath,
		);
		expect(atDesc).toContain("test subject");
		expect(atDesc).toContain("Meta: source: diff");
		expect(atDesc).toContain(sessionBookmark(otherId));
		expect(atDesc).not.toContain(sessionBookmark(sessionId));

		// The foreign bookmark moved to the stamped change…
		const bmTarget = jj(
			[
				"log",
				"-r",
				sessionBookmark(otherId),
				"--no-graph",
				"-T",
				"description.first_line()",
			],
			otherPath,
		);
		expect(bmTarget).toBe("test subject");

		// …and the foreign working copy is sealed (a fresh empty change on top).
		expect(jj(["status"], otherPath)).not.toContain("other.txt");

		// The issuer's own bookmark is untouched.
		const ownBookmark = jj(["bookmark", "list"], cwd);
		expect(ownBookmark).not.toContain(`${sessionBookmark(sessionId)}:`);
	}, 20_000);

	it("leaves the issuing conversation's pending interaction untouched", async () => {
		const cwd = initRepo();
		const otherId = "other-1";
		const otherPath = makeForeignSession(cwd, otherId);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		// The issuer's interaction is pending: prompt recorded, agent running.
		await runner.emitInput(
			"My pending interaction",
			undefined,
			"interactive",
		);
		recordUserMessage(runner, "My pending interaction");

		// Stamp the foreign session mid-interaction.
		await runSillajje(runner, `stamp -s ${otherId}`);

		// The issuer's interaction still auto-stamps at settle.
		writeFileSync(join(workspace, "own.ts"), "// own\n");
		recordAssistantMessage(runner, assistantMsg("Own work done."));
		await runner.emit({ type: "agent_settled" });

		const ownLog = jj(
			[
				"log",
				"-r",
				`ancestors(${sessionBookmark(sessionId)})`,
				"--no-graph",
				"-T",
				"description",
			],
			workspace,
		);
		expect(ownLog).toContain("My pending interaction");

		// The foreign change's provenance names the foreign session.
		const otherDesc = jj(
			["log", "-r", "@-", "--no-graph", "-T", "description"],
			otherPath,
		);
		expect(otherDesc).toContain(sessionBookmark(otherId));
	}, 20_000);

	it("reports the archived-session error for a bookmark without a workspace", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		// Give the current session a bookmark, then archive it (workspace
		// directory gone, bookmark survives).
		writeFileSync(join(workspace, "wip.ts"), "// wip\n");
		await runner.emitInput("work", undefined, "interactive");
		await runner.emitBeforeAgentStart(
			"work",
			undefined,
			"You are helpful.",
			{
				skills: [],
				contextFiles: [],
				cwd: "",
			},
		);
		await runner.emit({ type: "agent_start" });
		await runner.emit({
			type: "agent_end",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			messages: [assistantMsg("done.")] as any[],
		});
		await runSillajje(runner, `archive`);

		const notifications: Array<[string, string]> = [];
		runner.setUIContext(
			{
				setStatus: () => {},
				notify: (msg: string, type: "info" | "warning" | "error") =>
					notifications.push([msg, type]),
				setEditorText: () => {},
				getEditorText: () => "",
			} as unknown as Parameters<typeof runner.setUIContext>[0],
			"tui",
		);

		await runSillajje(runner, `stamp -s ${sessionId}`);

		expect(
			notifications.some(
				(n) =>
					n[1] === "error" &&
					n[0].includes("archived") &&
					n[0].includes("unarchive it first"),
			),
		).toBe(true);
	}, 20_000);

	it("reports the not-a-session error for an unknown session id", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const notifications: Array<[string, string]> = [];
		runner.setUIContext(
			{
				setStatus: () => {},
				notify: (msg: string, type: "info" | "warning" | "error") =>
					notifications.push([msg, type]),
				setEditorText: () => {},
				getEditorText: () => "",
			} as unknown as Parameters<typeof runner.setUIContext>[0],
			"tui",
		);

		await runSillajje(runner, "stamp -s ghost-session");

		expect(
			notifications.some(
				(n) =>
					n[1] === "error" &&
					n[0].includes("not a sillajje session") &&
					n[0].includes("ghost-session"),
			),
		).toBe(true);
	}, 15_000);
});
