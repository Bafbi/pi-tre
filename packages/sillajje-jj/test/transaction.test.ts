import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJj, type ExecFn } from "../src/index.js";
import { initRepo, jj, realExec, stopRealJj, useRealJj } from "./real-jj.js";

beforeAll(useRealJj);
afterAll(stopRealJj);

/** A real-jj ExecFn that fails the commands `fail` matches and records them. */
function failingExec(
	fail: (sub: string[]) => boolean,
	seen?: string[][],
): ExecFn {
	return async (command, args, options) => {
		const sub = args.filter((a) => a !== "--color=never");
		if (fail(sub)) {
			seen?.push(sub);
			return {
				code: 1,
				stdout: "",
				stderr: "injected failure\n",
				killed: false,
			};
		}
		return realExec(command, args, options);
	};
}

/** The state a failed transaction must not disturb. */
function repoState(cwd: string): string {
	return [
		jj(cwd, ["log", "--no-graph", "-T", 'change_id ++ "\\n"']),
		jj(cwd, ["bookmark", "list"]),
		jj(cwd, ["op", "log", "--no-graph", "-T", 'id ++ "\\n"']),
		jj(cwd, ["log", "-r", "@", "--no-graph", "-T", "description"]),
	].join("\n---\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Jj.transaction against real jj", () => {
	it("rolls a failed chain back to the pre-transaction state", async () => {
		const cwd = initRepo();
		const before = repoState(cwd);
		const jjApi = createJj(failingExec((sub) => sub[0] === "bookmark"));

		const result = await jjApi.transaction(
			async (tx) => {
				await tx.apply({
					kind: "describe",
					rev: "@",
					message: "stamped",
				});
				await tx.apply({
					kind: "bookmarkSet",
					name: "sillajje/test",
					rev: "@",
				});
			},
			{ cwd },
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("command");
		}
		expect(repoState(cwd)).toBe(before);
	});

	it("continues a chain through a no-op step and integrates once", async () => {
		const cwd = initRepo();
		// Make the working copy already carry the seal body so describe is a no-op.
		jj(cwd, ["describe", "-m", "same body"]);
		const jjApi = createJj(realExec);

		const result = await jjApi.transaction(
			async (tx) => {
				await tx.apply({
					kind: "describe",
					rev: "@",
					message: "same body",
				});
				await tx.apply({
					kind: "bookmarkSet",
					name: "sillajje/test",
					rev: "@",
				});
				await tx.apply({ kind: "new" });
			},
			{ cwd },
		);

		expect(result.ok).toBe(true);
		expect(jj(cwd, ["bookmark", "list", "-T", 'name ++ "\\n"'])).toContain(
			"sillajje/test",
		);
		// The new working copy is empty and undescribed — `jj new` landed.
		expect(
			jj(cwd, ["log", "-r", "@", "--no-graph", "-T", "description"]),
		).toBe("");
	});

	it("reports an integrate failure with the op id and preserves the chain", async () => {
		const cwd = initRepo();
		const seen: string[][] = [];
		const jjApi = createJj(
			failingExec(
				(sub) => sub[0] === "op" && sub[1] === "integrate",
				seen,
			),
		);

		const result = await jjApi.transaction(
			async (tx) => {
				await tx.apply({
					kind: "describe",
					rev: "@",
					message: "stamped",
				});
			},
			{ cwd },
		);

		expect(result.ok).toBe(false);
		if (!result.ok && result.error.kind === "integrate") {
			expect(result.error.op).toMatch(/^[0-9a-f]{12,}$/);
		} else {
			throw new Error("expected an integrate failure");
		}
		// The chain is the recovery path: no abandon ran.
		expect(seen).toHaveLength(1);
		expect(
			seen.some((sub) => sub[0] === "op" && sub[1] === "abandon"),
		).toBe(false);
	});

	it("reports a failed rollback alongside the primary failure", async () => {
		const cwd = initRepo();
		const jjApi = createJj(
			failingExec(
				(sub) =>
					sub[0] === "bookmark" ||
					(sub[0] === "op" && sub[1] === "abandon"),
			),
		);

		const result = await jjApi.transaction(
			async (tx) => {
				await tx.apply({
					kind: "describe",
					rev: "@",
					message: "stamped",
				});
				await tx.apply({
					kind: "bookmarkSet",
					name: "sillajje/test",
					rev: "@",
				});
			},
			{ cwd },
		);

		expect(result.ok).toBe(false);
		if (!result.ok && result.error.kind === "command") {
			expect(result.error.rollback).toBeDefined();
			expect(result.error.rollback?.op).toMatch(/^[0-9a-f]{12,}$/);
		} else {
			throw new Error("expected a command failure with a rollback");
		}
	});
});

describe("created-commit discovery", () => {
	it("discovers the commit a `new` Mutation creates", async () => {
		const cwd = initRepo();
		const jjApi = createJj(realExec);

		const result = await jjApi.apply({ kind: "new" }, { cwd });

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("apply failed");
		expect(result.value.created).toHaveLength(1);
		expect(result.value.created[0]!.commitId).toBe(
			jj(cwd, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]),
		);
	});

	it("discovers the commit a `duplicate` Mutation creates", async () => {
		const cwd = initRepo();
		const jjApi = createJj(realExec);

		const result = await jjApi.apply(
			{ kind: "duplicate", revset: "@", destination: "@-" },
			{ cwd },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("apply failed");
		expect(result.value.created).toHaveLength(1);
		expect(result.value.created[0]!.description).toBe("work\n");
	});
});
