import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * stale-write-guard must load AFTER sillajje. Sillajje rewrites tool input
 * paths to the sillajje workspace by mutating the shared args object during
 * tool_call. The guard's tool_result handler always sees those rewritten
 * paths, so its tool_call handler must see them too — otherwise reads record
 * workspace mtimes while edits check repo-checkout mtimes, and every
 * read-then-edit blocks forever.
 */
describe("pi-tre package manifest", () => {
	const manifestPath = resolve(
		import.meta.dirname,
		"../../../../package.json",
	);

	it("declares stale-write-guard after sillajje", () => {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		const extensions: string[] = manifest.pi.extensions;

		const sillajjeIndex = extensions.findIndex((p) =>
			p.includes("sillajje"),
		);
		const guardIndex = extensions.findIndex((p) =>
			p.includes("stale-write-guard"),
		);

		expect(sillajjeIndex).toBeGreaterThanOrEqual(0);
		expect(guardIndex).toBeGreaterThanOrEqual(0);
		expect(guardIndex).toBeGreaterThan(sillajjeIndex);
	});
});
