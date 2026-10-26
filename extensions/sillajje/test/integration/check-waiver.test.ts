/**
 * The waiver surface through the integration harness.
 *
 * The agent's waiver is a tool, so the test calls the registered tool the way
 * pi does, then lets the Interaction settle and reads the stamped change.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { setTestPorts } from "../../src/index.js";
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
	sessionBookmark,
	wsPath,
} from "./_helpers.js";

type Runner = Awaited<ReturnType<typeof createRunner>>;

function writeConfig(cwd: string, checks: unknown[]): void {
	const dir = join(cwd, ".pi/configs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "sillajje.json"),
		JSON.stringify({ checks, maxAttempts: 5 }),
	);
}

async function start(cwd: string): Promise<{
	runner: Runner;
	workspace: string;
	sessionId: string;
}> {
	const runner = await createRunner(cwd);
	await runner.emit({ type: "session_start", reason: "startup" });
	const sessionId = getSessionId(runner);
	return { runner, workspace: wsPath(cwd, sessionId), sessionId };
}

async function interact(runner: Runner): Promise<void> {
	await runner.emitInput("do the work", undefined, "interactive");
	recordInteraction(runner, "do the work", "Done.");
}

interface WaiverTool {
	execute: (
		id: string,
		params: { reason: string; checks?: string[] },
		signal: undefined,
		update: undefined,
		ctx: unknown,
	) => Promise<unknown>;
}

function waiverTool(runner: Runner): WaiverTool | undefined {
	return runner.getToolDefinition("waive_checks") as WaiverTool | undefined;
}

function waive(
	runner: Runner,
	params: { reason: string; checks?: string[] },
): Promise<unknown> {
	const tool = waiverTool(runner);
	if (tool === undefined) throw new Error("waive_checks is not registered");
	return tool.execute(
		"waive-1",
		params,
		undefined,
		undefined,
		runner.createToolContext("waive-1", undefined),
	);
}

async function settle(runner: Runner): Promise<void> {
	await runner.emit({ type: "agent_settled", aborted: false });
}

beforeEach(() => {
	installDefaultSubGeneratorMock();
});

describeJj("sillajje check waiver", () => {
	it("registers waive_checks only when the config declares a check", async () => {
		const withChecks = initRepo();
		writeConfig(withChecks, [{ name: "check", command: "true" }]);
		const first = await start(withChecks);
		expect(waiverTool(first.runner)).toBeDefined();

		const without = initRepo();
		const second = await start(without);
		expect(waiverTool(second.runner)).toBeUndefined();
	}, 30_000);

	it("ends the loop and stamps a waived check with its reason", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [{ name: "check", command: "false" }]);
		const { runner, workspace, sessionId } = await start(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await interact(runner);

		expect((await emitBoundary(runner, "completed")).continue).toBe(true);
		const { notifications } = captureUi(runner);
		await waive(runner, { reason: "integration DB unavailable" });
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "warning",
				msg: expect.stringContaining(
					"checks waived (integration DB unavailable)",
				),
			}),
		);

		// The next boundary settles without running another gate.
		expect((await emitBoundary(runner, "completed")).continue).toBe(false);
		await settle(runner);

		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain(
			"Checks: check waived (integration DB unavailable)",
		);
		const terminal = recordsIn(
			getSessionManager(runner).getBranch(),
			"check",
		).at(-1);
		expect(terminal?.checks?.[0]).toMatchObject({
			name: "check",
			status: "waived",
			reason: "integration DB unavailable",
		});
	}, 30_000);

	it("refuses a waiver when nothing is failing", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [{ name: "check", command: "false" }]);
		const { runner } = await start(cwd);

		await expect(waive(runner, { reason: "no DB" })).rejects.toThrow(
			/no check is failing/,
		);
	}, 30_000);

	it("refuses a waiver with no reason", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [{ name: "check", command: "false" }]);
		const { runner, workspace } = await start(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await interact(runner);
		await emitBoundary(runner, "completed");

		await expect(waive(runner, { reason: "   " })).rejects.toThrow(
			/non-empty reason/,
		);
	}, 30_000);

	it("refuses a named check that is not failing", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [{ name: "check", command: "false" }]);
		const { runner, workspace } = await start(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await interact(runner);
		await emitBoundary(runner, "completed");

		await expect(
			waive(runner, { reason: "no DB", checks: ["other"] }),
		).rejects.toThrow(/cannot waive other: not failing/);
	}, 30_000);

	it("waives named failing checks only, leaving the others red in the record", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [
			{ name: "lint", command: "false" },
			{ name: "test", command: "false" },
		]);
		const { runner, workspace, sessionId } = await start(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await interact(runner);
		await emitBoundary(runner, "completed");

		await waive(runner, {
			reason: "tool missing",
			checks: ["lint"],
		});
		await emitBoundary(runner, "completed");
		await settle(runner);

		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("lint waived (tool missing)");
		expect(show).toContain("test failed (exit 1");
	}, 30_000);

	it("lets Escape cancel a running check and settles with a cancelled waiver", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [
			{ name: "slow", command: "sleep 5", timeoutMs: 30_000 },
		]);
		const { runner, workspace, sessionId } = await start(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await interact(runner);

		const controller = new AbortController();
		setTestPorts({ signal: controller.signal });
		const boundary = emitBoundary(runner, "completed");
		setTimeout(() => controller.abort(), 150);

		const result = await boundary;
		expect(result.continue).toBe(false);

		await settle(runner);
		const show = jj(["show", sessionBookmark(sessionId)], cwd);
		expect(show).toContain("slow waived (cancelled)");
		const terminal = recordsIn(
			getSessionManager(runner).getBranch(),
			"check",
		).at(-1);
		expect(terminal?.checks?.[0]).toMatchObject({
			status: "waived",
			reason: "cancelled",
		});
	}, 30_000);
});
