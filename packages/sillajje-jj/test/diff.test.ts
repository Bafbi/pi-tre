/**
 * `Jj.diffFiles` against the installed jj.
 *
 * `diffFiles` pairs a `-T` path/status read with a `--stat` count read by
 * index. This test pins that the two reads agree in the real process: same
 * order, same count, and target paths that survive a space, a newline, a
 * binary file, and a rename.
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJj } from "../src/index.js";
import { initRepo, realExec, stopRealJj, useRealJj } from "./real-jj.js";

beforeAll(useRealJj);
afterAll(stopRealJj);

describe("Jj.diffFiles against real jj", () => {
	it("pairs summary status with stat counts in tree order", async () => {
		const cwd = initRepo();
		writeFileSync(join(cwd, "a.txt"), "hello\nworld\n");
		writeFileSync(join(cwd, "b.txt"), "one\ntwo\nthree\n");
		const jj = createJj(realExec);

		const files = await jj.diffFiles({ rev: "@" }, { cwd });

		expect(files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
		expect(files).toEqual([
			{ path: "a.txt", status: "modified", changes: 1 },
			{ path: "b.txt", status: "added", changes: 3 },
		]);
	});

	it("reports a removal's status and count", async () => {
		const cwd = initRepo();
		rmSync(join(cwd, "a.txt"));
		const jj = createJj(realExec);

		const files = await jj.diffFiles({ rev: "@" }, { cwd });

		expect(files).toEqual([
			{ path: "a.txt", status: "removed", changes: 1 },
		]);
	});

	it("counts an empty file and a binary file as zero changes", async () => {
		const cwd = initRepo();
		writeFileSync(join(cwd, "c.txt"), "");
		writeFileSync(join(cwd, "z.bin"), Buffer.from([0, 1, 2, 3, 255]));
		const jj = createJj(realExec);

		const files = await jj.diffFiles({ rev: "@" }, { cwd });

		expect(files).toEqual([
			{ path: "c.txt", status: "added", changes: 0 },
			{ path: "z.bin", status: "added", changes: 0 },
		]);
	});

	it("selects one file by exact path, even with a space in the name", async () => {
		const cwd = initRepo();
		writeFileSync(join(cwd, "a b.txt"), "x\n");
		writeFileSync(join(cwd, "c.txt"), "y\n");
		const jj = createJj(realExec);

		const text = await jj.diff("@", { cwd, filesets: ['file:"a b.txt"'] });

		expect(text).toContain("a b.txt");
		expect(text).not.toContain("c.txt");
	});

	it("keeps a path that holds a newline in one manifest record", async () => {
		const cwd = initRepo();
		writeFileSync(join(cwd, "first\nsecond.txt"), "x\n");
		const jj = createJj(realExec);

		const files = await jj.diffFiles({ rev: "@" }, { cwd });

		expect(files).toEqual([
			{ path: "first\nsecond.txt", status: "added", changes: 1 },
		]);
	});

	it("reports a rename by its target path", async () => {
		const cwd = initRepo();
		rmSync(join(cwd, "a.txt"));
		writeFileSync(join(cwd, "renamed.txt"), "hello\n");
		const jj = createJj(realExec);

		const files = await jj.diffFiles({ rev: "@" }, { cwd });

		const renamed = files.find((file) => file.status === "renamed");
		expect(renamed?.path).toBe("renamed.txt");
	});
});
