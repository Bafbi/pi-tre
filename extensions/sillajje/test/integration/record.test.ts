/**
 * Tests for Record persistence — the extension appends a start Record and a
 * terminal done/failed/noop Record to the session log for each operation.
 *
 * One seam: the extension integration harness. Each test drives a real jj repo
 * through `session_start` and reads `sillajje/record` entries off the branch.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
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
	sessionBookmark,
} from "./_helpers.js";

describeJj("sillajje records — Workspace", () => {
	it("writes a start and a done Record for a created Workspace", async () => {
		const runner = await createRunner(initRepo());
		await runner.emit({ type: "session_start", reason: "startup" });

		const records = recordsIn(
			getSessionManager(runner).getBranch(),
			"workspace",
		);

		expect(records.map((r) => r.stage)).toEqual(["start", "done"]);
		expect(records[0]).toMatchObject({
			v: 1,
			operation: "workspace",
			stage: "start",
		});
		expect(records[1]).toMatchObject({
			stage: "done",
			result: { status: "created", fromRoot: true },
		});
	});

	it("records a reused Workspace as a noop", async () => {
		const runner = await createRunner(initRepo());
		await runner.emit({ type: "session_start", reason: "startup" });
		await runner.emit({ type: "session_start", reason: "startup" });

		const records = recordsIn(
			getSessionManager(runner).getBranch(),
			"workspace",
		);

		expect(records.map((r) => r.stage)).toEqual([
			"start",
			"done",
			"start",
			"noop",
		]);
		expect(records[3]).toMatchObject({
			stage: "noop",
			result: { status: "reused" },
		});
	});

	it("records an archived session's failed Workspace", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		// A surviving bookmark means the session is archived, not new.
		jj(
			[
				"bookmark",
				"create",
				sessionBookmark(getSessionId(runner)),
				"-r",
				"@",
			],
			cwd,
		);
		await runner.emit({ type: "session_start", reason: "startup" });

		const records = recordsIn(
			getSessionManager(runner).getBranch(),
			"workspace",
		);

		expect(records.map((r) => r.stage)).toEqual(["start", "failed"]);
		expect(records[1]).toMatchObject({
			stage: "failed",
			result: { reason: "archived" },
		});
	});
});

describeJj("sillajje records — guards", () => {
	it("records a corrected old command form as a guard Record", async () => {
		const runner = await createRunner(initRepo());

		await runner.emitInput("/sillajje stamp", undefined, "interactive");

		const records = recordsIn(
			getSessionManager(runner).getBranch(),
			"guard",
		);
		expect(records.map((r) => r.stage)).toEqual(["start", "done"]);
		expect(records[0]).toMatchObject({
			v: 1,
			operation: "guard",
			stage: "start",
			input: { command: "/sillajje stamp" },
		});
		expect(records[1]).toMatchObject({
			stage: "done",
			result: { corrected: "/sillajje:stamp" },
		});
	});

	it("records a blocked absolute path as a guard Record", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		await runner.emitToolCall({
			type: "tool_call" as const,
			toolCallId: "read-1",
			toolName: "read" as const,
			input: { path: join(cwd, "secret.ts") },
		});

		const records = recordsIn(
			getSessionManager(runner).getBranch(),
			"guard",
		);
		expect(records.map((r) => r.stage)).toEqual(["start", "done"]);
		expect(records[1]).toMatchObject({
			stage: "done",
			result: { blocked: "absolute-path" },
		});
	});
});

describeJj("sillajje records — Seed", () => {
	it("records a copy at session start", async () => {
		const cwd = initRepo();
		writeFileSync(join(cwd, ".env"), "SECRET=1\n");
		mkdirSync(join(cwd, ".pi/configs"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi/configs/sillajje.json"),
			JSON.stringify({ seed: [".env"] }),
		);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const records = recordsIn(
			getSessionManager(runner).getBranch(),
			"seed",
		);
		expect(records.map((r) => r.stage)).toEqual(["start", "done"]);
		expect(records[1]).toMatchObject({
			trigger: "copy",
			result: { copied: [".env"] },
		});
	});
});

describeJj("sillajje records — Stamp", () => {
	it("records an auto-stamp with its source and diagnostics", async () => {
		installDefaultSubGeneratorMock();
		const runner = await createRunner(initRepo());
		await runner.emit({ type: "session_start", reason: "startup" });
		recordInteraction(runner, "do work", "done");
		await runner.emit({ type: "agent_settled" });

		const records = recordsIn(
			getSessionManager(runner).getBranch(),
			"stamp",
		);
		expect(records.map((r) => r.stage)).toEqual(["start", "done"]);
		expect(records[1]).toMatchObject({
			trigger: "auto",
			change: expect.any(String),
			result: { source: "interaction" },
			diff: { omitted: [] },
			generator: { fallbacks: [] },
		});
		expect(records[1]?.change).not.toBe("@");
	});
});

describeJj("sillajje records — Archive", () => {
	it("records the archive command", async () => {
		const runner = await createRunner(initRepo());
		await runner.emit({ type: "session_start", reason: "startup" });

		await runSillajje(runner, "archive");

		const records = recordsIn(
			getSessionManager(runner).getBranch(),
			"archive",
		);
		expect(records.map((r) => r.stage)).toEqual(["start", "done"]);
		expect(records[1]).toMatchObject({
			trigger: "command",
			result: { status: "removed" },
		});
	});
});
