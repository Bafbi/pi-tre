import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadWebSearchConfig, webSearchConfigPaths } from "../../src/config.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeGlobal(configDir: string, config: unknown): void {
	writeFileSync(join(configDir, "web-search.json"), JSON.stringify(config));
}

function writeProject(repoRoot: string, config: unknown): void {
	const dir = join(repoRoot, ".pi", "configs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "web-search.json"), JSON.stringify(config));
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("loadWebSearchConfig", () => {
	it("spends nothing when no config file exists", () => {
		const configDir = makeTempDir("web-search-global-");
		const cwd = makeTempDir("web-search-repo-");

		const config = loadWebSearchConfig({ cwd, configDir });

		expect(config.enabled).toBe(false);
	});

	it("fills the defaults around an empty file", () => {
		const configDir = makeTempDir("web-search-global-");
		const cwd = makeTempDir("web-search-repo-");
		writeGlobal(configDir, {});

		const config = loadWebSearchConfig({ cwd, configDir });

		expect(config).toEqual({
			enabled: false,
			maxResults: 8,
			timeoutMs: 25000,
			credentialProvider: "opencode-go",
			endpoint: "https://opencode.ai/console/api/websearch",
		});
	});

	it("reads the global layer", () => {
		const configDir = makeTempDir("web-search-global-");
		const cwd = makeTempDir("web-search-repo-");
		writeGlobal(configDir, { enabled: true, maxResults: 3 });

		const config = loadWebSearchConfig({ cwd, configDir });

		expect(config.enabled).toBe(true);
		expect(config.maxResults).toBe(3);
	});

	it("ignores the project layer when the project is untrusted", () => {
		const configDir = makeTempDir("web-search-global-");
		const cwd = makeTempDir("web-search-repo-");
		writeProject(cwd, { enabled: true });

		const config = loadWebSearchConfig({ cwd, configDir, trusted: false });

		expect(config.enabled).toBe(false);
	});

	it("reads the project layer when the project is trusted", () => {
		const configDir = makeTempDir("web-search-global-");
		const cwd = makeTempDir("web-search-repo-");
		writeProject(cwd, {
			enabled: true,
			endpoint: "https://example.test/search",
		});

		const config = loadWebSearchConfig({ cwd, configDir, trusted: true });

		expect(config.enabled).toBe(true);
		expect(config.endpoint).toBe("https://example.test/search");
	});

	it("names the files the loader actually reads", () => {
		const configDir = makeTempDir("web-search-global-");
		const cwd = makeTempDir("web-search-repo-");
		const paths = webSearchConfigPaths(cwd, configDir);

		expect(paths.global).toBe(join(configDir, "web-search.json"));
		expect(paths.project).toBe(
			join(cwd, ".pi", "configs", "web-search.json"),
		);

		writeFileSync(paths.global, JSON.stringify({ enabled: true }));
		expect(loadWebSearchConfig({ cwd, configDir }).enabled).toBe(true);

		rmSync(paths.global);
		mkdirSync(join(cwd, ".pi", "configs"), { recursive: true });
		writeFileSync(paths.project, JSON.stringify({ enabled: true }));
		expect(
			loadWebSearchConfig({ cwd, configDir, trusted: true }).enabled,
		).toBe(true);
	});

	it("drops a layer whose value fails the schema, keeping the spend off", () => {
		const configDir = makeTempDir("web-search-global-");
		const cwd = makeTempDir("web-search-repo-");
		writeGlobal(configDir, { enabled: true, maxResults: 0 });

		const config = loadWebSearchConfig({ cwd, configDir });

		expect(config.enabled).toBe(false);
		expect(config.maxResults).toBe(8);
	});
});
