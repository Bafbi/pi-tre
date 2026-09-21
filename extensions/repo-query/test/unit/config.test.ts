import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadRepoQueryConfig, resolveModel } from "../../src/config.js";
import type { ParsedRepo } from "../../src/types.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeGlobal(configDir: string, config: unknown): void {
	writeFileSync(join(configDir, "repo-query.json"), JSON.stringify(config));
}

function writeProject(repoRoot: string, config: unknown): void {
	const dir = join(repoRoot, ".pi", "configs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "repo-query.json"), JSON.stringify(config));
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	vi.unstubAllEnvs();
});

describe("loadRepoQueryConfig", () => {
	it("returns an empty config when no files exist", () => {
		const configDir = makeTempDir("repo-query-global-");
		const cwd = makeTempDir("repo-query-repo-");

		const config = loadRepoQueryConfig({ cwd, configDir });

		expect(config).toEqual({});
	});

	it("reads the global layer", () => {
		const configDir = makeTempDir("repo-query-global-");
		const cwd = makeTempDir("repo-query-repo-");
		writeGlobal(configDir, { defaultModel: "openai/gpt-4o" });

		const config = loadRepoQueryConfig({ cwd, configDir });

		expect(config.defaultModel).toBe("openai/gpt-4o");
	});

	it("resolves the global layer through PI_CODING_AGENT_DIR", () => {
		const agentDir = makeTempDir("repo-query-agent-");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		mkdirSync(join(agentDir, "configs"), { recursive: true });
		writeFileSync(
			join(agentDir, "configs", "repo-query.json"),
			JSON.stringify({ defaultModel: "from-agent-dir" }),
		);
		const cwd = makeTempDir("repo-query-repo-");

		const config = loadRepoQueryConfig({ cwd });

		expect(config.defaultModel).toBe("from-agent-dir");
	});

	it("reads the project layer when trusted", () => {
		const configDir = makeTempDir("repo-query-global-");
		const cwd = makeTempDir("repo-query-repo-");
		writeProject(cwd, { defaultModel: "project-model" });

		const config = loadRepoQueryConfig({ cwd, configDir, trusted: true });

		expect(config.defaultModel).toBe("project-model");
	});

	it("ignores the project layer when not trusted", () => {
		const configDir = makeTempDir("repo-query-global-");
		const cwd = makeTempDir("repo-query-repo-");
		writeGlobal(configDir, { defaultModel: "global-model" });
		writeProject(cwd, { defaultModel: "project-model" });

		const config = loadRepoQueryConfig({ cwd, configDir });

		expect(config.defaultModel).toBe("global-model");
	});

	it("merges global and project, the project winning per models key", () => {
		const configDir = makeTempDir("repo-query-global-");
		const cwd = makeTempDir("repo-query-repo-");
		writeGlobal(configDir, {
			defaultModel: "global-model",
			models: { "owner/a": "global-a", "owner/c": "global-c" },
		});
		writeProject(cwd, {
			defaultModel: "project-model",
			models: { "owner/a": "project-a", "owner/b": "project-b" },
		});

		const config = loadRepoQueryConfig({ cwd, configDir, trusted: true });

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

	it("returns undefined when nothing matches and REPO_QUERY_MODEL is unset", () => {
		vi.stubEnv("REPO_QUERY_MODEL", undefined);
		const config = {};
		const repos = [{ displayName: "foo/bar" }] as ParsedRepo[];
		expect(resolveModel(config, repos)).toBeUndefined();
	});

	it("handles empty repos array", () => {
		const config = { defaultModel: "default" };
		expect(resolveModel(config, [])).toBe("default");
	});

	it("falls back to REPO_QUERY_MODEL env var when no config match", () => {
		vi.stubEnv("REPO_QUERY_MODEL", "env-model");
		const config = {};
		const repos = [{ displayName: "foo/bar" }] as ParsedRepo[];
		expect(resolveModel(config, repos)).toBe("env-model");
	});
});
