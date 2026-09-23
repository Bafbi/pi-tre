/**
 * The old space form (`/sillajje stamp`) is retired. The adapter must catch it
 * on the input event and correct the user, so the stale text never reaches the
 * model. The guard stays narrow: a colon command is untouched.
 */

import { describe, expect, it } from "vitest";
import { createRunner, makeRunnerCwd } from "./_helpers.js";

describe("sillajje old-form guard", () => {
	it("corrects the old space form and stops it reaching the model", async () => {
		const cwd = makeRunnerCwd();
		const notifications: Array<[string, string]> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push([msg, type]),
		});

		const result = await runner.emitInput(
			"/sillajje stamp -s @",
			undefined,
			"interactive",
		);

		expect(result).toEqual({ action: "handled" });
		expect(
			notifications.some((n) => n[0].includes("/sillajje:stamp")),
		).toBe(true);
	});

	it("catches the bare command", async () => {
		const cwd = makeRunnerCwd();
		const notifications: Array<[string, string]> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push([msg, type]),
		});

		const result = await runner.emitInput(
			"/sillajje",
			undefined,
			"interactive",
		);

		expect(result).toEqual({ action: "handled" });
		expect(notifications.some((n) => n[1] === "warning")).toBe(true);
	});

	it("leaves a valid colon command alone", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);

		const result = await runner.emitInput(
			"/sillajje:unarchive abc",
			undefined,
			"interactive",
		);

		expect(result).not.toEqual({ action: "handled" });
	});

	it("leaves an unknown colon subcommand alone", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);

		const result = await runner.emitInput(
			"/sillajje:nope",
			undefined,
			"interactive",
		);

		expect(result).not.toEqual({ action: "handled" });
	});
});
