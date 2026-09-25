import { describe, expect, it } from "vitest";

import { createJj, JjError } from "../src/index.js";
import { fail, ok, recordingExec } from "./helpers.js";

describe("gitPush", () => {
	it("runs jj git push with the bookmark and no remote", async () => {
		const { exec, calls } = recordingExec(() => ok());
		const jj = createJj(exec);

		await expect(
			jj.gitPush({ bookmark: "review" }),
		).resolves.toBeUndefined();
		expect(calls[0]!.args).toEqual([
			"git",
			"push",
			"-b",
			"review",
			"--color=never",
		]);
	});

	it("passes --remote when the remote is named", async () => {
		const { exec, calls } = recordingExec(() => ok());
		const jj = createJj(exec);

		await jj.gitPush({ bookmark: "review", remote: "origin" });

		expect(calls[0]!.args).toEqual([
			"git",
			"push",
			"-b",
			"review",
			"--remote",
			"origin",
			"--color=never",
		]);
	});

	it("throws a query failure when the push fails", async () => {
		const { exec } = recordingExec(() => fail("no such remote"));
		const jj = createJj(exec);

		const error = await jj
			.gitPush({ bookmark: "review", remote: "ghost" })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(JjError);
		expect((error as JjError).failure).toMatchObject({
			kind: "query",
			exitCode: 1,
			stderr: "no such remote",
		});
	});
});
