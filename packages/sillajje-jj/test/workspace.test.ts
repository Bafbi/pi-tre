import { describe, expect, it } from "vitest";

import { createJj, JjError } from "../src/index.js";
import { fail, ok, recordingExec } from "./helpers.js";

describe("workspace lifecycle verbs", () => {
	it("adds a workspace and returns its name and root", async () => {
		const { exec, calls } = recordingExec(() => ok());
		const jj = createJj(exec);

		await expect(
			jj.workspaceAdd({
				name: "sillajje/a",
				revision: "@-",
				path: "/ws/a",
			}),
		).resolves.toEqual({ name: "sillajje/a", root: "/ws/a" });
		expect(calls[0]!.args).toEqual([
			"workspace",
			"add",
			"--name",
			"sillajje/a",
			"--revision",
			"@-",
			"/ws/a",
			"--color=never",
		]);
	});

	it("returns the root jj registered, not the requested path", async () => {
		const { exec, calls } = recordingExec((args) =>
			args.includes("list") ? ok("sillajje/a:/canonical/a\n") : ok(),
		);
		const jj = createJj(exec);

		await expect(
			jj.workspaceAdd({
				name: "sillajje/a",
				revision: "@-",
				path: "/ws/a",
			}),
		).resolves.toEqual({ name: "sillajje/a", root: "/canonical/a" });
		expect(calls[1]!.args).toEqual([
			"workspace",
			"list",
			"-T",
			'name ++ ":" ++ root ++ "\\n"',
			"--color=never",
		]);
	});

	it("forgets a workspace by name", async () => {
		const { exec, calls } = recordingExec(() => ok());
		const jj = createJj(exec);

		await expect(jj.workspaceForget("sillajje/a")).resolves.toBeUndefined();
		expect(calls[0]!.args).toEqual([
			"workspace",
			"forget",
			"sillajje/a",
			"--color=never",
		]);
	});

	it("updates a stale workspace", async () => {
		const { exec, calls } = recordingExec(() => ok());
		const jj = createJj(exec);

		await expect(jj.workspaceUpdateStale()).resolves.toBeUndefined();
		expect(calls[0]!.args).toEqual([
			"workspace",
			"update-stale",
			"--color=never",
		]);
	});

	it("throws a query failure when a workspace verb fails", async () => {
		const { exec } = recordingExec(() => fail("no such workspace"));
		const jj = createJj(exec);

		const error = await jj
			.workspaceForget("sillajje/a")
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(JjError);
		expect((error as JjError).failure).toMatchObject({
			kind: "query",
			exitCode: 1,
			stderr: "no such workspace",
		});
	});
});
