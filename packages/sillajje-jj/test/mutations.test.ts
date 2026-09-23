import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJj } from "../src/index.js";
import { initRepo, jj, realExec, stopRealJj, useRealJj } from "./real-jj.js";

beforeAll(useRealJj);
afterAll(stopRealJj);

describe("Jj.conflicts against real jj", () => {
	it("lists conflicted paths from the commit template", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "jj-conflict-"));
		execFileSync("jj", ["git", "init", "--quiet"], {
			cwd,
			stdio: "pipe",
		});
		writeFileSync(join(cwd, "f.txt"), "base\n");
		execFileSync("jj", ["describe", "-m", "base"], { cwd, stdio: "pipe" });
		const base = jj(cwd, [
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			"change_id",
		]);
		execFileSync("jj", ["new", base, "-m", "left"], { cwd, stdio: "pipe" });
		writeFileSync(join(cwd, "f.txt"), "left\n");
		const left = jj(cwd, [
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			"change_id",
		]);
		execFileSync("jj", ["new", base, "-m", "right"], {
			cwd,
			stdio: "pipe",
		});
		writeFileSync(join(cwd, "f.txt"), "right\n");
		const right = jj(cwd, [
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			"change_id",
		]);
		execFileSync("jj", ["new", left, right, "-m", "merge"], {
			cwd,
			stdio: "pipe",
		});

		const jjApi = createJj(realExec);
		await expect(jjApi.conflicts(undefined, { cwd })).resolves.toEqual([
			"f.txt",
		]);
		// `resolve --list` is never used; this read exits 0 even with conflicts.
	});
});

describe("Jj.apply — squash and rebase", () => {
	it("squashes a change into its parent", async () => {
		const cwd = initRepo();
		writeFileSync(join(cwd, "b.txt"), "new work\n");
		jj(cwd, ["describe", "-m", "second"]);

		const jjApi = createJj(realExec);
		const result = await jjApi.apply(
			{ kind: "squash", from: "@", onto: "@-", message: "squashed" },
			{ cwd },
		);

		expect(result.ok).toBe(true);
		expect(
			jj(cwd, [
				"log",
				"-r",
				"@-",
				"--no-graph",
				"-T",
				"description.first_line()",
			]),
		).toBe("squashed");
	});

	it("rebases a change onto a new parent", async () => {
		const cwd = initRepo();
		// Two siblings of root: `@` (source) and a new target branch.
		const root = jj(cwd, [
			"log",
			"-r",
			"@-",
			"--no-graph",
			"-T",
			"change_id",
		]);
		const source = jj(cwd, [
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			"change_id",
		]);
		execFileSync("jj", ["new", root, "-m", "target"], {
			cwd,
			stdio: "pipe",
		});
		const target = jj(cwd, [
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			"change_id",
		]);

		const jjApi = createJj(realExec);
		const result = await jjApi.apply(
			{ kind: "rebase", source, onto: [target] },
			{ cwd },
		);

		expect(result.ok).toBe(true);
		expect(
			jj(cwd, [
				"log",
				"-r",
				source,
				"--no-graph",
				"-T",
				'parents.map(|p| p.change_id()).join(" ")',
			]),
		).toBe(target);
	});
});
