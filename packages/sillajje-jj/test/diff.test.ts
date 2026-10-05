/**
 * `Jj.diffFiles` against the installed jj.
 *
 * `diffFiles` pairs a `--summary` read with a `--stat` read by index. This test
 * pins that the two reads agree in the real process: same order, same count,
 * and exact (never elided) paths from `--summary`. It covers the rows the
 * decoder special-cases: an empty file and a binary file, both zero changes.
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
});
