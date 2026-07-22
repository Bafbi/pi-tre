import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadRepoQueryConfig, resolveModel } from "../../src/config.js";
import type { ParsedRepo } from "../../src/types.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "repo-query-config-test-"));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	vi.unstubAllEnvs();
});

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
	vi.unstubAllEnvs();
});

describe("loadRepoQueryConfig", () => {
	it("returns empty config when no files exist", () => {
		const agentDir = makeTempDir();
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

		const cwd = makeTempDir();
		const config = loadRepoQueryConfig(cwd);
		expect(config).toEqual({ models: {} });
	});

	it("loads project-local config", () => {
		const agentDir = makeTempDir();
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

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
		const agentDir = makeTempDir();
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

		// Global config
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(agentDir, "extensions", "repo-query.json"),
			JSON.stringify({
				defaultModel: "global-model",
				models: { "owner/a": "global-a", "owner/c": "global-c" },
			}),
			"utf8",
		);

		// Project config
		const cwd = makeTempDir();
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "extensions", "repo-query.json"),
			JSON.stringify({
				defaultModel: "project-model",
				models: { "owner/a": "project-a", "owner/b": "project-b" },
			}),
			"utf8",
		);

		const config = loadRepoQueryConfig(cwd);
		expect(config.defaultModel).toBe("project-model");
		expect(config.models).toEqual({
			"owner/a": "project-a",
			"owner/b": "project-b",
			"owner/c": "global-c",
		});
	});
});

describe("resolveModel", () => {
	it("falls back to per-repo config", () => {
		const config = {
			defaultModel: "default",
			models: { "foo/bar": "per-repo" },
		};
		const repos = [{ displayName: "foo/bar" }] as ParsedRepo[];
		expect(resolveModel(config, repos)).toBe("per-repo");
	});

	it("falls back to defaultModel when no repo match", () => {
		const config = {
			defaultModel: "default",
			models: { "other/repo": "per-repo" },
		};
		const repos = [{ displayName: "foo/bar" }] as ParsedRepo[];
		expect(resolveModel(config, repos)).toBe("default");
	});

	it("returns undefined when nothing matches and TEST_MODEL is unset", () => {
		vi.stubEnv("TEST_MODEL", undefined);
		const config = {};
		const repos = [{ displayName: "foo/bar" }] as ParsedRepo[];
		expect(resolveModel(config, repos)).toBeUndefined();
	});

	it("handles empty repos array", () => {
		const config = { defaultModel: "default" };
		expect(resolveModel(config, [])).toBe("default");
	});

	it("falls back to TEST_MODEL env var when no config match", () => {
		vi.stubEnv("TEST_MODEL", "env-model");
		const config = {};
		const repos = [{ displayName: "foo/bar" }] as ParsedRepo[];
		expect(resolveModel(config, repos)).toBe("env-model");
	});
});
