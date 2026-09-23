/**
 * The stamp action reaches jj only through `@pi-tre/sillajje-jj`.
 *
 * The facade is the one place that builds argv. A direct `exec("jj", ...)` in
 * the stamp module is the regression this test catches.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stampDir = join(dirname(fileURLToPath(import.meta.url)), "../src/stamp");

const files = readdirSync(stampDir, { recursive: true })
	.map(String)
	.filter((entry) => entry.endsWith(".ts"));

describe("the stamp action has no direct jj execution", () => {
	it("scopes at least one file", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it.each(files)("%s goes through the jj facade", (file) => {
		const source = readFileSync(join(stampDir, file), "utf-8");
		expect(source).not.toMatch(/\bexec\(\s*["']jj["']/);
	});
});
