/**
 * The settle gate through the extension integration harness.
 *
 * The checks are tiny real shell commands, and the assertions are what a
 * reader of `jj show` and the session log sees. Stubbing process execution
 * would test the stub, and the gate's whole point is that it runs a real
 * command against the real workspace.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import {
	captureUi,
	createRunner,
	describeJj,
	emitBoundary,
	getSessionId,
	getSessionManager,
	initRepo,
	installDefaultSubGeneratorMock,
	jj,
	recordInteraction,
	recordsIn,
	runSillajje,
	sessionBookmark,
	wsPath,
} from "./_helpers.js";

type Runner = Awaited<ReturnType<typeof createRunner>>;

interface CheckConfigFile {
	name: string;
	command: string;
	triggers?: string[];
	timeoutMs?: number;
	paths?: string[];
}

function writeConfig(
	cwd: string,
	checks: CheckConfigFile[],
	maxAttempts = 5,
): void {
	const dir = join(cwd, ".pi/configs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "sillajje.json"),
		JSON.stringify({ checks, maxAttempts }),
	);
}

async function startSession(
	cwd: string,
): Promise<{ runner: Runner; workspace: string; sessionId: string }> {
	const runner = await createRunner(cwd);
	await runner.emit({ type: "session_start", reason: "startup" });
	const sessionId = getSessionId(runner);
	return { runner, workspace: wsPath(cwd, sessionId), sessionId };
}

async function beginInteraction(runner: Runner): Promise<void> {
	await runner.emitInput("do the work", undefined, "interactive");
	recordInteraction(runner, "do the work", "Done.");
}

beforeEach(() => {
	installDefaultSubGeneratorMock();
});

describeJj("sillajje settle check gate", () => {
	it("runs a declared check at settle, shows it running, and records a passed verdict", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [
			{ name: "check", command: "true", triggers: ["settle"] },
		]);
		const { runner, workspace, sessionId } = await startSession(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await beginInteraction(runner);

		const boundary = await emitBoundary(runner, "completed");

		expect(boundary.continue).toBe(false);
		const records = recordsIn(
			getSessionManager(runner).getBranch(),
			"check",
		);
		expect(records.map((record) => record.stage)).toEqual([
			"start",
			"done",
		]);
		expect(records[0]).toMatchObject({
			trigger: "settle",
			attempt: 1,
		});
		expect(records[1]).toMatchObject({
			trigger: "settle",
			attempt: 1,
			checks: [
				{
					name: "check",
					status: "passed",
				},
			],
		});
		expect(records[1]?.digest).toMatch(/^[0-9a-f]{64}$/);

		await runner.emit({ type: "agent_settled", aborted: false });
		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("Checks: check passed");
	}, 30_000);

	it("renders the held gate verdict on a manual stamp of the current session", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [{ name: "check", command: "true" }]);
		const { runner, workspace, sessionId } = await startSession(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await beginInteraction(runner);

		const boundary = await emitBoundary(runner, "completed");
		expect(boundary.continue).toBe(false);

		await runSillajje(runner, "stamp -s @");

		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("Checks: check passed");
	}, 30_000);

	it("runs every settle check in declared order and reports every failure", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [
			{ name: "first", command: "false" },
			{ name: "second", command: "true" },
			{ name: "third", command: "exit 3" },
		]);
		const { runner, workspace } = await startSession(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await beginInteraction(runner);

		await emitBoundary(runner, "completed");

		const terminal = recordsIn(
			getSessionManager(runner).getBranch(),
			"check",
		).at(-1);
		expect(terminal?.checks?.map((entry) => entry.name)).toEqual([
			"first",
			"second",
			"third",
		]);
		expect(terminal?.checks?.[0]).toMatchObject({
			status: "failed",
			exitCode: 1,
		});
		expect(terminal?.checks?.[1]?.status).toBe("passed");
		expect(terminal?.checks?.[2]).toMatchObject({
			status: "failed",
			exitCode: 3,
		});
	}, 30_000);

	it("maps a check that outlives its timeout to timed-out and red", async () => {
		const cwd = initRepo();
		writeConfig(
			cwd,
			[
				{
					name: "slow",
					command: "sleep 2",
					timeoutMs: 100,
				},
			],
			1,
		);
		const { runner, workspace } = await startSession(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await beginInteraction(runner);

		const boundary = await emitBoundary(runner, "completed");
		expect(boundary.continue).toBe(false);
		const terminal = recordsIn(
			getSessionManager(runner).getBranch(),
			"check",
		).at(-1);
		expect(terminal?.checks?.[0]).toMatchObject({ status: "timed-out" });
	}, 30_000);

	it("skips the gate when the interaction changed nothing", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [{ name: "check", command: "true" }]);
		const { runner, sessionId } = await startSession(cwd);
		await beginInteraction(runner);

		const boundary = await emitBoundary(runner, "completed");

		expect(boundary.continue).toBe(false);
		expect(
			recordsIn(getSessionManager(runner).getBranch(), "check"),
		).toHaveLength(0);

		await runner.emit({ type: "agent_settled", aborted: false });
		const show = jj(
			["log", "-r", sessionBookmark(sessionId), "-T", "description"],
			cwd,
		);
		expect(show).not.toContain("Checks:");
	}, 30_000);

	it("does not start the gate for an already aborted run", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [{ name: "check", command: "true" }]);
		const { runner, workspace } = await startSession(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await beginInteraction(runner);

		const boundary = await emitBoundary(runner, "aborted");

		expect(boundary.continue).toBe(false);
		expect(
			recordsIn(getSessionManager(runner).getBranch(), "check"),
		).toHaveLength(0);
	}, 30_000);

	it("runs no check when the config declares none", async () => {
		const cwd = initRepo();
		const { runner, workspace } = await startSession(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await beginInteraction(runner);

		const boundary = await emitBoundary(runner, "completed");

		expect(boundary.continue).toBe(false);
		expect(
			recordsIn(getSessionManager(runner).getBranch(), "check"),
		).toHaveLength(0);
	}, 30_000);

	it("hands a red gate to the agent with the raw output and a full-log pointer", async () => {
		const cwd = initRepo();
		writeConfig(
			cwd,
			[
				{
					name: "check",
					command: "echo broken-output; exit 7",
				},
			],
			1,
		);
		const { runner, workspace } = await startSession(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await beginInteraction(runner);
		const { notifications } = captureUi(runner);

		const boundary = await emitBoundary(runner, "completed");

		expect(boundary.continue).toBe(false);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "error",
				msg: expect.stringContaining("check (exit 7)"),
			}),
		);
		const report = boundary.entries.find(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "sillajje/check-report",
		);
		expect(report).toBeDefined();
		expect(
			report?.type === "custom_message" ? report.content : "",
		).toContain("broken-output");
		expect(
			report?.type === "custom_message" ? report.content : "",
		).toContain(".checks/check.log");
	}, 30_000);

	it("writes a distinct log for check names that sanitize alike", async () => {
		const cwd = initRepo();
		writeConfig(
			cwd,
			[
				{ name: "a/b", command: "echo slash; exit 1" },
				{ name: "a?b", command: "echo question; exit 1" },
			],
			1,
		);
		const { runner, workspace } = await startSession(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await beginInteraction(runner);

		const boundary = await emitBoundary(runner, "completed");
		const report = boundary.entries.find(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "sillajje/check-report",
		);
		const content =
			report?.type === "custom_message" &&
			typeof report.content === "string"
				? report.content
				: "";
		const logs = [...content.matchAll(/Full output: (.*)/g)].map(
			(match) => match[1],
		);
		expect(logs).toHaveLength(2);
		expect(new Set(logs).size).toBe(2);
	}, 30_000);

	it("truncates a long report to a tail and points at the complete log", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [{ name: "check", command: "seq 1 2100; exit 1" }], 1);
		const { runner, workspace } = await startSession(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await beginInteraction(runner);

		const boundary = await emitBoundary(runner, "completed");
		const report = boundary.entries.find(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "sillajje/check-report",
		);
		const content = report?.type === "custom_message" ? report.content : "";
		expect(content).toContain("[output truncated; full log:");
		expect(content).not.toContain("\n1\n");
		expect(content).toContain("\n2100");
	}, 30_000);

	it("continues after a red gate and settles green once the agent fixes it", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [{ name: "check", command: "test -f fixed" }]);
		const { runner, workspace, sessionId } = await startSession(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await beginInteraction(runner);

		const first = await emitBoundary(runner, "completed");
		expect(first.continue).toBe(true);

		// The agent fixes the tree and settles again.
		writeFileSync(join(workspace, "fixed"), "yes\n");
		const second = await emitBoundary(runner, "completed");
		expect(second.continue).toBe(false);

		await runner.emit({ type: "agent_settled", aborted: false });
		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("Checks: check passed");
	}, 30_000);

	it("settles red when the tree did not change between attempts", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [{ name: "check", command: "false" }]);
		const { runner, workspace } = await startSession(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await beginInteraction(runner);

		expect((await emitBoundary(runner, "completed")).continue).toBe(true);
		const stalled = await emitBoundary(runner, "completed");
		expect(stalled.continue).toBe(false);

		const runs = recordsIn(
			getSessionManager(runner).getBranch(),
			"check",
		).filter((record) => record.stage === "start");
		expect(runs).toHaveLength(2);
	}, 30_000);

	it("settles on the fifth red gate", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [{ name: "check", command: "false" }], 5);
		const { runner, workspace } = await startSession(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await beginInteraction(runner);

		const results: boolean[] = [];
		for (let attempt = 0; attempt < 5; attempt++) {
			results.push((await emitBoundary(runner, "completed")).continue);
			// Change the tree so the stall rule does not cut the loop short.
			writeFileSync(
				join(workspace, "attempt.txt"),
				`attempt ${attempt}\n`,
			);
		}

		expect(results).toEqual([true, true, true, true, false]);
	}, 60_000);

	it("filters a check by the interaction's changed paths", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [{ name: "src", command: "true", paths: ["src/**"] }]);
		const { runner, workspace, sessionId } = await startSession(cwd);
		writeFileSync(join(workspace, "docs.md"), "docs\n");
		await beginInteraction(runner);

		const skipped = await emitBoundary(runner, "completed");
		expect(skipped.continue).toBe(false);
		const terminal = recordsIn(
			getSessionManager(runner).getBranch(),
			"check",
		).at(-1);
		expect(terminal?.checks?.[0]?.status).toBe("skipped");

		await runner.emit({ type: "agent_settled", aborted: false });
		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).not.toContain("Checks:");
	}, 30_000);

	it("runs a path-filtered check when a matching file changes", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [{ name: "src", command: "true", paths: ["src/**"] }]);
		const { runner, workspace } = await startSession(cwd);
		mkdirSync(join(workspace, "src"), { recursive: true });
		writeFileSync(join(workspace, "src", "app.ts"), "src\n");
		await beginInteraction(runner);

		await emitBoundary(runner, "completed");
		const terminal = recordsIn(
			getSessionManager(runner).getBranch(),
			"check",
		).at(-1);
		expect(terminal?.checks?.[0]?.status).toBe("passed");
	}, 30_000);
});
