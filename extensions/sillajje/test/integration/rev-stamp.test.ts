/**
 * Integration tests for the Rev stamp (`/sillajje stamp -r <rev>`) against
 * real jj, driven through the registered command.
 */

import { execSync } from "node:child_process";
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
	runSillajje,
	wsPath,
} from "./_helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a stray change with content and an empty description, return its change id. */
function makeStrayChange(cwd: string, file: string, content: string): string {
	writeFileSync(join(cwd, file), content);
	execSync("jj new", { cwd, stdio: "pipe" });
	// The stray change is now `@-`.
	return jj(["log", "-r", "@-", "--no-graph", "-T", "change_id"], cwd);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
	installDefaultSubGeneratorMock();
});

describeJj("sillajje rev stamp", () => {
	it("describes a stray change with a generated header and provenance; bookmarks and change count unchanged", async () => {
		const cwd = initRepo();
		const strayId = makeStrayChange(cwd, "stray.ts", "// stray\n");

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		// Baselines after session_start — workspace creation itself adds a
		// working-copy change to the log, and the stamp must add none.
		const bookmarksBefore = jj(["bookmark", "list"], cwd);
		const logBefore = jj(["log", "--no-graph", "-T", "change_id"], cwd);

		await runSillajje(runner, `stamp -r ${strayId.slice(0, 8)}`);

		// The stray change is described.
		const desc = jj(
			[
				"log",
				"-r",
				`change_id(${strayId})`,
				"--no-graph",
				"-T",
				"description",
			],
			cwd,
		);
		expect(desc).toContain("test subject");
		expect(desc).toContain("Meta: trigger: rev");
		expect(desc).toContain(`rev: ${strayId.slice(0, 8)}`);

		// Nothing else moved: same bookmarks, same changes.
		expect(jj(["bookmark", "list"], cwd)).toBe(bookmarksBefore);
		expect(jj(["log", "--no-graph", "-T", "change_id"], cwd)).toBe(
			logBefore,
		);
	}, 15_000);

	it("accepts -r @ and stays describe-only (no seal)", async () => {
		const cwd = initRepo();

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		// With an active session, `@` is the sillajje workspace's working copy.
		const changeBefore = jj(
			["log", "-r", "@", "--no-graph", "-T", "change_id"],
			workspace,
		);
		writeFileSync(join(workspace, "pending.ts"), "// pending\n");

		await runSillajje(runner, "stamp -r @");

		// `@` is described but NOT sealed: the same change is still the
		// working copy — no `jj new` sealed it, and the file remains there.
		const atDesc = jj(
			["log", "-r", "@", "--no-graph", "-T", "description"],
			workspace,
		);
		expect(atDesc).toContain("test subject");
		expect(
			jj(["log", "-r", "@", "--no-graph", "-T", "change_id"], workspace),
		).toBe(changeBefore);
		expect(jj(["status"], workspace)).toContain("pending.ts");
	}, 15_000);

	it("rejects --rev and --session together with a usage message", async () => {
		const cwd = initRepo();
		const strayId = makeStrayChange(cwd, "stray.ts", "// stray\n");
		const descBefore = jj(
			[
				"log",
				"-r",
				`change_id(${strayId})`,
				"--no-graph",
				"-T",
				"description",
			],
			cwd,
		);

		const notifications: Array<[string, string]> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push([msg, type]),
		});
		await runner.emit({ type: "session_start", reason: "startup" });

		await runSillajje(
			runner,
			`stamp -r ${strayId.slice(0, 8)} -s other-session`,
		);

		expect(notifications.some((n) => n[1] === "warning")).toBe(true);
		expect(
			notifications.some((n) => n[0].includes("usage: /sillajje stamp")),
		).toBe(true);

		// Nothing changed.
		const descAfter = jj(
			[
				"log",
				"-r",
				`change_id(${strayId})`,
				"--no-graph",
				"-T",
				"description",
			],
			cwd,
		);
		expect(descAfter).toBe(descBefore);
	}, 15_000);

	it("reports no-changes on an empty target rev, naming the rev", async () => {
		const cwd = initRepo();
		const notifications: Array<[string, string]> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push([msg, type]),
		});
		await runner.emit({ type: "session_start", reason: "startup" });

		// `@` is empty in a fresh repo.
		await runSillajje(runner, "stamp -r @");

		expect(
			notifications.some(
				(n) =>
					n[1] === "info" &&
					n[0].includes("@") &&
					n[0].includes("no changes"),
			),
		).toBe(true);
	}, 15_000);

	it("leaves the current session's pending interaction intact for the next auto-stamp", async () => {
		const cwd = initRepo();
		const strayId = makeStrayChange(cwd, "stray.ts", "// stray\n");

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const sessionId = getSessionId(runner);

		// Interaction 1 auto-stamps normally.
		await runner.emitInput("First interaction", undefined, "interactive");
		await runner.emitBeforeAgentStart(
			"First interaction",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], prompts: [] },
		);
		await runner.emit({ type: "agent_start" });
		await runner.emit({
			type: "agent_end",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			messages: [assistantMsg("First done.")] as any[],
		});

		// Interaction 2 starts: its prompt is recorded as pending.
		await runner.emitInput("Pending interaction", undefined, "interactive");
		await runner.emitBeforeAgentStart(
			"Pending interaction",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], prompts: [] },
		);

		// A rev stamp runs mid-interaction and must NOT touch the pending one.
		await runSillajje(runner, `stamp -r ${strayId.slice(0, 8)}`);

		// Interaction 2 ends — the pending interaction still auto-stamps.
		await runner.emit({ type: "agent_start" });
		writeFileSync(join(cwd, "pending.ts"), "// pending\n");
		await runner.emit({
			type: "agent_end",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			messages: [assistantMsg("Pending done.")] as any[],
		});

		const log = jj(
			[
				"log",
				"-r",
				`ancestors(sillajje/${sessionId})`,
				"--no-graph",
				"-T",
				"description",
			],
			cwd,
		);
		expect(log).toContain("First interaction");
		expect(log).toContain("Pending interaction");
	}, 20_000);

	it("stamps from the repo root when the conversation has no live sillajje session", async () => {
		const cwd = initRepo();
		const strayId = makeStrayChange(cwd, "stray.ts", "// stray\n");

		// No session_start: the sillajje state stays inactive — no workspace,
		// no stored repo root. The command still finds the repo from ctx.cwd.
		const runner = await createRunner(cwd);

		await runSillajje(runner, `stamp -r ${strayId.slice(0, 8)}`);

		const desc = jj(
			[
				"log",
				"-r",
				`change_id(${strayId})`,
				"--no-graph",
				"-T",
				"description",
			],
			cwd,
		);
		expect(desc).toContain("test subject");
		expect(desc).toContain("Meta: trigger: rev");
	}, 15_000);

	it("relays jj's error when the target rev does not resolve", async () => {
		const cwd = initRepo();
		const notifications: Array<[string, string]> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push([msg, type]),
		});
		await runner.emit({ type: "session_start", reason: "startup" });

		await runSillajje(runner, "stamp -r nosuchrev");

		// jj explains its own failure; the stderr text reaches the user.
		expect(
			notifications.some(
				(n) =>
					n[1] === "error" &&
					n[0].includes("nosuchrev") &&
					n[0].includes("doesn't exist"),
			),
		).toBe(true);
	}, 15_000);

	it("relays jj's error when the target rev is immutable", async () => {
		const cwd = initRepo();
		// Point a tag at `@-` — its diff is non-empty, so the stamp reaches
		// the describe step, where jj refuses the immutable change.
		jj(["tag", "set", "v1", "-r", "@-"], cwd);
		const descBefore = jj(
			["log", "-r", "v1", "--no-graph", "-T", "description"],
			cwd,
		);

		const notifications: Array<[string, string]> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push([msg, type]),
		});
		await runner.emit({ type: "session_start", reason: "startup" });

		await runSillajje(runner, "stamp -r v1");

		expect(
			notifications.some(
				(n) => n[1] === "error" && n[0].includes("immutable"),
			),
		).toBe(true);
		// The describe was refused — the immutable change is untouched.
		expect(
			jj(["log", "-r", "v1", "--no-graph", "-T", "description"], cwd),
		).toBe(descBefore);
	}, 15_000);
});
