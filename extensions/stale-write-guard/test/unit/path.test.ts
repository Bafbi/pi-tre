import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCanonicalPath } from "../../src/path";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("resolveCanonicalPath", () => {
	it("resolves relative paths from cwd", () => {
		const result = resolveCanonicalPath("src/file.ts", "/work/project");
		expect(result).toBe(resolve("/work/project", "src/file.ts"));
	});

	it("strips the '@' tool prefix like pi's tools do", () => {
		const cwd = "/work/project";
		expect(resolveCanonicalPath("@src/file.ts", cwd)).toBe(
			resolve(cwd, "src/file.ts"),
		);
	});

	it("expands home paths", () => {
		const result = resolveCanonicalPath("~/notes.txt", "/ignored");
		expect(result).toBe(resolve(process.env.HOME ?? "", "notes.txt"));
	});

	it("resolves symlink aliases to the same canonical path", () => {
		const dir = mkdtempSync(join(tmpdir(), "stale-write-guard-"));
		tempDirs.push(dir);

		const target = join(dir, "target.txt");
		const link = join(dir, "alias.txt");
		writeFileSync(target, "hello\n", "utf8");
		symlinkSync(target, link);

		expect(resolveCanonicalPath(target, "/")).toBe(
			resolveCanonicalPath(link, "/"),
		);
	});

	it("falls back for non-existing paths", () => {
		const cwd = "/tmp/project";
		const canonical = resolveCanonicalPath("does-not-exist.txt", cwd);
		expect(canonical).toBe(resolve(cwd, "does-not-exist.txt"));
	});
});
