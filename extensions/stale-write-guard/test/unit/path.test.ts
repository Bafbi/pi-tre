import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalizePath, resolveCanonicalPath, resolveFromCwd } from "../../src/path";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("path helpers", () => {
	it("resolves relative paths from cwd", () => {
		const result = resolveFromCwd("src/file.ts", "/work/project");
		expect(result).toBe(resolve("/work/project", "src/file.ts"));
	});

	it("expands home paths", () => {
		const result = resolveFromCwd("~/notes.txt", "/ignored");
		expect(result.startsWith(process.env.HOME ?? "")).toBe(true);
	});

	it("canonicalizePath resolves symlink aliases to the same canonical path", () => {
		const dir = mkdtempSync(join(tmpdir(), "stale-write-guard-"));
		tempDirs.push(dir);

		const target = join(dir, "target.txt");
		const link = join(dir, "alias.txt");
		writeFileSync(target, "hello\n", "utf8");
		symlinkSync(target, link);

		const canonicalTarget = canonicalizePath(target);
		const canonicalLink = canonicalizePath(link);

		expect(canonicalTarget).toBe(canonicalLink);
	});

	it("resolveCanonicalPath falls back for non-existing paths", () => {
		const cwd = "/tmp/project";
		const canonical = resolveCanonicalPath("does-not-exist.txt", cwd);
		expect(canonical).toBe(resolve(cwd, "does-not-exist.txt"));
	});
});
