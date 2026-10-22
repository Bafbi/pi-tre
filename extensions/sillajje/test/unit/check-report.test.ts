/**
 * The Check report's own seam: what a red gate writes and renders when a
 * check could not start at all.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCheckReport } from "../../src/check-report.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("buildCheckReport", () => {
	it("keeps a failure reason that produced no output", () => {
		const dir = mkdtempSync(join(tmpdir(), "sillajje-report-"));
		dirs.push(dir);

		const report = buildCheckReport(
			[
				{
					name: "check",
					status: "failed",
					durationMs: 0,
					reason: "spawn failed",
				},
			],
			dir,
		);

		expect(report.message).toContain("spawn failed");
		const log = report.logs.get("check");
		expect(log).toBeDefined();
		expect(readFileSync(log ?? "", "utf-8")).toContain("spawn failed");
	});
});
