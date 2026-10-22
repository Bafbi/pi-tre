/**
 * `/sillajje:check` through the integration harness.
 *
 * The command runs the same gate the settle and publish Triggers run, reports
 * into the transcript, and starts no turn.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import {
	captureUi,
	createRunner,
	describeJj,
	getSessionId,
	getSessionManager,
	initRepo,
	installDefaultSubGeneratorMock,
	recordInteraction,
	recordsIn,
	runSillajje,
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

function checkReports(runner: Runner): string[] {
	return getSessionManager(runner)
		.getBranch()
		.filter(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "sillajje/check-report",
		)
		.map((entry) =>
			entry.type === "custom_message" && typeof entry.content === "string"
				? entry.content
				: "",
		);
}

beforeEach(() => {
	installDefaultSubGeneratorMock();
});

describeJj("sillajje check command", () => {
	it("runs every declared check and reports green without starting a turn", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [
			{ name: "check", command: "true", triggers: ["settle"] },
			{ name: "ci", command: "true", triggers: ["publish"] },
		]);
		const { runner, workspace } = await start(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");
		await runner.emitInput("do work", undefined, "interactive");
		recordInteraction(runner, "do work", "Done.");
		const { notifications } = captureUi(runner);

		await runSillajje(runner, "check");

		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining("checks: check, ci passed"),
			}),
		);
		const terminal = recordsIn(
			getSessionManager(runner).getBranch(),
			"check",
		).at(-1);
		expect(terminal).toMatchObject({
			trigger: "manual",
			checks: [
				{ name: "check", status: "passed" },
				{ name: "ci", status: "passed" },
			],
		});
		expect(checkReports(runner)).toEqual([]);
	}, 30_000);

	it("narrows the run to one gate with --trigger", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [
			{ name: "fast", command: "true", triggers: ["settle"] },
			{ name: "full", command: "true", triggers: ["publish"] },
		]);
		const { runner } = await start(cwd);

		await runSillajje(runner, "check --trigger publish");

		const terminal = recordsIn(
			getSessionManager(runner).getBranch(),
			"check",
		).at(-1);
		expect(terminal?.checks?.map((entry) => entry.name)).toEqual(["full"]);
	}, 30_000);

	it("reports a red run into the transcript and warns", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [
			{ name: "check", command: "echo check-broke; exit 1" },
		]);
		const { runner } = await start(cwd);
		const { notifications } = captureUi(runner);

		await runSillajje(runner, "check");

		const reports = checkReports(runner);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toContain("check-broke");
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "warning",
				msg: expect.stringContaining("check failed: check"),
			}),
		);
		const terminal = recordsIn(
			getSessionManager(runner).getBranch(),
			"check",
		).at(-1);
		expect(terminal).toMatchObject({
			stage: "failed",
			trigger: "manual",
		});
	}, 30_000);

	it("refuses a session with no live workspace instead of inventing one", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [{ name: "check", command: "true" }]);
		const { runner } = await start(cwd);
		const { notifications } = captureUi(runner);

		await runSillajje(runner, "check -s nobody");

		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "error",
				msg: expect.stringContaining("cannot check"),
			}),
		);
		expect(
			recordsIn(getSessionManager(runner).getBranch(), "check"),
		).toHaveLength(0);
	}, 30_000);

	it("leaves the settle gate alone: a manual run is evidence, not a cache", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [{ name: "check", command: "true" }]);
		const { runner, workspace } = await start(cwd);
		writeFileSync(join(workspace, "work.txt"), "work\n");

		await runSillajje(runner, "check");

		expect(
			recordsIn(getSessionManager(runner).getBranch(), "check"),
		).toHaveLength(2);
		// Both records are the manual run; no settle verdict was stored.
		expect(
			recordsIn(getSessionManager(runner).getBranch(), "check").map(
				(record) => record.trigger,
			),
		).toEqual(["manual", "manual"]);
	}, 30_000);

	it("corrects the retired space form to the colon form", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [{ name: "check", command: "true" }]);
		const { runner } = await start(cwd);
		const { notifications } = captureUi(runner);

		const result = await runner.emitInput(
			"/sillajje check",
			undefined,
			"interactive",
		);

		expect(result).toEqual({ action: "handled" });
		expect(
			notifications.some((entry) =>
				entry.msg.includes("/sillajje:check"),
			),
		).toBe(true);
	}, 30_000);
});
