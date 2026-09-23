/**
 * The core is pi-free.
 *
 * `packages/pi-subagent` is the pi adapter and is out of scope — it imports
 * pi by design. Every other `sillajje-*` boundary package must not, in its
 * manifest, its sources, or its tests.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packagesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"packages",
);

const scopedPackages = readdirSync(packagesDir, { withFileTypes: true })
	.filter(
		(entry) => entry.isDirectory() && entry.name.startsWith("sillajje-"),
	)
	.map((entry) => entry.name);

/** An import or dynamic import of a pi package, not a mention in a comment. */
const PI_IMPORT =
	/from\s+["']@earendil-works\/pi-|import\(\s*["']@earendil-works\/pi-/;

describe("the sillajje boundary packages are pi-free", () => {
	it("scopes at least one boundary package", () => {
		expect(scopedPackages.length).toBeGreaterThan(0);
	});

	it.each(scopedPackages)("%s imports no pi package", (name) => {
		const root = join(packagesDir, name);
		expect(readFileSync(join(root, "package.json"), "utf-8")).not.toMatch(
			/@earendil-works\/pi-/,
		);

		for (const dir of ["src", "test"]) {
			const full = join(root, dir);
			if (!existsSync(full)) continue;
			for (const file of readdirSync(full, { recursive: true }).map(
				String,
			)) {
				if (!file.endsWith(".ts")) continue;
				expect(
					readFileSync(join(full, file), "utf-8"),
					`${name}/${dir}/${file}`,
				).not.toMatch(PI_IMPORT);
			}
		}
	});
});
