/**
 * The publish gate through `/sillajje:fold` against real jj.
 *
 * A red check publishes nothing; `--no-check` publishes and records the
 * waiver. The check runs once, before the transaction opens.
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
	jj,
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

async function interact(runner: Runner): Promise<void> {
	await runner.emitInput("do the work", undefined, "interactive");
	recordInteraction(runner, "do the work", "Done.");
	await runner.emit({ type: "agent_settled", aborted: false });
}

/** Put main on the home revision, above the session's fork point. */
function advanceMain(cwd: string): string {
	const base = jj(["log", "-r", "@-", "--no-graph", "-T", "change_id"], cwd);
	writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
	jj(["describe", "-m", "feat: upstream"], cwd);
	jj(["bookmark", "set", "main", "-r", "@"], cwd);
	return base;
}

/** A commit's full, multi-line description. */
function fullDescription(cwd: string, rev: string): string {
	return jj(["log", "-r", rev, "--no-graph", "-T", "description"], cwd);
}

function childrenOf(
	cwd: string,
	rev: string,
): Array<{ id: string; description: string }> {
	const out = jj(
		[
			"log",
			"-r",
			`children(${rev})`,
			"--no-graph",
			"-T",
			'change_id ++ "|" ++ description.first_line() ++ "\\n"',
		],
		cwd,
	);
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [id, ...rest] = line.split("|");
			return { id: id ?? "", description: rest.join("|") };
		});
}

beforeEach(() => {
	installDefaultSubGeneratorMock();
});

describeJj("sillajje publish check gate", () => {
	it("runs the publish check before folding and records a pass", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [
			{ name: "ci", command: "true", triggers: ["publish"] },
		]);
		const { runner, workspace } = await start(cwd);
		writeFileSync(join(workspace, "session.txt"), "session work\n");
		await interact(runner);
		advanceMain(cwd);

		await runSillajje(runner, "fold -s @ -o main");

		const children = childrenOf(cwd, "main");
		expect(children).toHaveLength(1);
		expect(fullDescription(cwd, children[0]?.id ?? "")).toContain(
			"Checks: ci passed",
		);
		expect(
			recordsIn(getSessionManager(runner).getBranch(), "check").at(-1),
		).toMatchObject({
			stage: "done",
			trigger: "publish",
			checks: [{ name: "ci", status: "passed" }],
		});
	}, 30_000);

	it("blocks the fold when the publish check is red", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [
			{ name: "ci", command: "false", triggers: ["publish"] },
		]);
		const { runner, workspace } = await start(cwd);
		writeFileSync(join(workspace, "session.txt"), "session work\n");
		await interact(runner);
		advanceMain(cwd);
		const before = childrenOf(cwd, "main").length;
		const { notifications } = captureUi(runner);

		await runSillajje(runner, "fold -s @ -o main");

		expect(childrenOf(cwd, "main")).toHaveLength(before);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "error",
				msg: expect.stringContaining(
					"publish check failed: ci (exit 1)",
				),
			}),
		);
		const checkRecords = recordsIn(
			getSessionManager(runner).getBranch(),
			"check",
		);
		expect(checkRecords.at(-1)).toMatchObject({
			stage: "failed",
			trigger: "publish",
			checks: [{ name: "ci", status: "failed", exitCode: 1 }],
		});
	}, 30_000);

	it("publishes with --no-check and records the waiver in Checks", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [
			{ name: "ci", command: "false", triggers: ["publish"] },
		]);
		const { runner, workspace } = await start(cwd);
		writeFileSync(join(workspace, "session.txt"), "session work\n");
		await interact(runner);
		advanceMain(cwd);

		await runSillajje(runner, "fold -s @ -o main --no-check");

		const children = childrenOf(cwd, "main");
		expect(children).toHaveLength(1);
		expect(fullDescription(cwd, children[0]?.id ?? "")).toContain(
			"ci waived (--no-check)",
		);
	}, 30_000);

	it("refuses to check a workspace that differs from the sealed source", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [
			{ name: "ci", command: "true", triggers: ["publish"] },
		]);
		const { runner, workspace } = await start(cwd);
		writeFileSync(join(workspace, "session.txt"), "session work\n");
		await interact(runner);
		advanceMain(cwd);
		// An unsealed edit would be checked but not published.
		writeFileSync(join(workspace, "unsealed.txt"), "not stamped\n");
		const before = childrenOf(cwd, "main").length;
		const { notifications } = captureUi(runner);

		await runSillajje(runner, "fold -s @ -o main");

		expect(childrenOf(cwd, "main")).toHaveLength(before);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "error",
				msg: expect.stringContaining("uncommitted workspace edits"),
			}),
		);

		await runSillajje(runner, "fold -s @ -o main --no-check");
		expect(childrenOf(cwd, "main")).toHaveLength(before + 1);
	}, 30_000);

	it("returns no-changes for a no-op fold before running the publish check", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [
			{ name: "ci", command: "false", triggers: ["publish"] },
		]);
		const { runner, workspace } = await start(cwd);
		writeFileSync(join(workspace, "session.txt"), "session work\n");
		await interact(runner);
		advanceMain(cwd);

		await runSillajje(
			runner,
			"fold -s @ -o main --named review --no-check",
		);
		const { notifications } = captureUi(runner);

		await runSillajje(runner, "fold -s @ -o main --named review");

		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining("nothing to fold"),
			}),
		);
		expect(
			notifications.some((entry) =>
				entry.msg.includes("publish check failed"),
			),
		).toBe(false);
		expect(
			recordsIn(getSessionManager(runner).getBranch(), "check"),
		).toHaveLength(1);
	}, 30_000);

	it("refuses a revision source when a publish check exists", async () => {
		const cwd = initRepo();
		writeConfig(cwd, [
			{ name: "ci", command: "true", triggers: ["publish"] },
		]);
		const { runner } = await start(cwd);
		jj(["bookmark", "set", "main", "-r", "@-"], cwd);
		writeFileSync(join(cwd, "rev.txt"), "rev work\n");
		const before = childrenOf(cwd, "main").length;
		const { notifications } = captureUi(runner);

		await runSillajje(runner, "fold -r @ -o main");

		expect(childrenOf(cwd, "main")).toHaveLength(before);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "error",
				msg: expect.stringContaining("--no-check"),
			}),
		);
	}, 30_000);

	it("folds a revision source unchanged when no publish check exists", async () => {
		const cwd = initRepo();
		const { runner } = await start(cwd);
		jj(["bookmark", "set", "main", "-r", "@-"], cwd);
		writeFileSync(join(cwd, "rev.txt"), "rev work\n");
		const before = childrenOf(cwd, "main").length;

		await runSillajje(runner, "fold -r @ -o main");

		expect(childrenOf(cwd, "main")).toHaveLength(before + 1);
	}, 30_000);
});
