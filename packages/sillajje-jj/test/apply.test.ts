import { describe, expect, it } from "vitest";

import { createJj } from "../src/index.js";
import { fail, ok, recordingExec } from "./helpers.js";

const HEAD = "a".repeat(40);

describe("Jj.apply — describe", () => {
	it("runs the describe Mutation integrated and returns its operation", async () => {
		const { exec, calls } = recordingExec((args) => {
			if (args[0] === "describe") return ok();
			if (args[0] === "op") return ok(`${HEAD}\n`);
			return fail(`unexpected ${args.join(" ")}`);
		});
		const jj = createJj(exec);

		const result = await jj.apply({
			kind: "describe",
			rev: "@",
			message: "body",
		});

		expect(result).toEqual({
			ok: true,
			value: { op: HEAD, created: [] },
		});
		expect(calls[0]!.args).toEqual([
			"describe",
			"-r",
			"@",
			"-m",
			"body",
			"--color=never",
		]);
		// The resulting operation is read from the head, never parsed from a summary.
		expect(calls[1]!.args).toEqual([
			"op",
			"log",
			"-n",
			"1",
			"--no-graph",
			"-T",
			"id",
			"--color=never",
		]);
	});

	it("returns a typed command failure when the Mutation exits non-zero", async () => {
		const { exec } = recordingExec(() => fail("immutable"));
		const jj = createJj(exec);

		const result = await jj.apply({
			kind: "describe",
			rev: "@",
			message: "body",
		});

		expect(result).toEqual({
			ok: false,
			error: {
				kind: "command",
				mutation: { kind: "describe", rev: "@", message: "body" },
				exitCode: 1,
				stderr: "immutable",
			},
		});
	});

	it("returns a query failure when the resulting operation cannot be read", async () => {
		const { exec } = recordingExec((args) =>
			args[0] === "describe" ? ok() : fail("no op log"),
		);
		const jj = createJj(exec);

		const result = await jj.apply({
			kind: "describe",
			rev: "@",
			message: "body",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("query");
		}
	});
});
