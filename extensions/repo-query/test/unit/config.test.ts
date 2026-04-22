import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadRepoQueryConfig, resolveModel } from "../../src/config.js";
import type { ParsedRepo } from "../../src/types.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "repo-query-config-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("loadRepoQueryConfig", () => {
	it("returns empty config when no files exist", () => {
		const cwd = makeTempDir();
		const config = loadRepoQueryConfig(cwd);
		expect(config).toEqual({ models: {} });
	});

	it("loads project-local config", () => {
		const cwd = makeTempDir();
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "extensions", "repo-query.json"),
			JSON.stringify({ defaultModel: "openai/gpt-4o" }),
			"utf8",
		);

		const config = loadRepoQueryConfig(cwd);
		expect(config.defaultModel).toBe("openai/gpt-4o");
	});

	it("merges global and project config with project taking precedence", () => {
		const cwd = makeTempDir();
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "extensions", "repo-query.json"),
			JSON.stringify({
				defaultModel: "project-model",
				models: { "owner/a": "model-a", "owner/b": "model-b" },
			}),
			"utf8",
		);

		const config = loadRepoQueryConfig(cwd);
		expect(config.defaultModel).toBe("project-model");
		expect(config.models).toEqual({
			"owner/a": "model-a",
			"owner/b": "model-b",
		});
	});
});

describe("resolveModel", () => {
	it("falls back to per-repo config", () => {
		const config = { defaultModel: "default", models: { "foo/bar": "per-repo" } };
		const repos = [{ displayName: "foo/bar" }] as ParsedRepo[];
		expect(resolveModel(config, repos)).toBe("per-repo");
	});

	it("falls back to defaultModel when no repo match", () => {
		const config = { defaultModel: "default", models: { "other/repo": "per-repo" } };
		const repos = [{ displayName: "foo/bar" }] as ParsedRepo[];
		expect(resolveModel(config, repos)).toBe("default");
	});

	it("returns undefined when nothing matches and TEST_MODEL is unset", () => {
		const original = process.env.TEST_MODEL;
		// biome-ignore lint/performance/noDelete: process.env values are always strings; delete is required to truly remove a key
		delete process.env.TEST_MODEL;
		try {
			const config = {};
			const repos = [{ displayName: "foo/bar" }] as ParsedRepo[];
			expect(resolveModel(config, repos)).toBeUndefined();
		} finally {
			if (original !== undefined) {
				process.env.TEST_MODEL = original;
			}
		}
	});

	it("handles empty repos array", () => {
		const config = { defaultModel: "default" };
		expect(resolveModel(config, [])).toBe("default");
	});

	it("falls back to TEST_MODEL env var when no config match", () => {
		const original = process.env.TEST_MODEL;
		process.env.TEST_MODEL = "env-model";
		try {
			const config = {};
			const repos = [{ displayName: "foo/bar" }] as ParsedRepo[];
			expect(resolveModel(config, repos)).toBe("env-model");
		} finally {
			if (original === undefined) {
				// biome-ignore lint/performance/noDelete: process.env values are always strings; delete is required to truly remove a key
				delete process.env.TEST_MODEL;
			} else {
				process.env.TEST_MODEL = original;
			}
		}
	});
});
