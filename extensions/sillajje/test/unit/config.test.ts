import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSillajjeConfig } from "../../src/config";

const GLOBAL_CONFIG_DIR = join(homedir(), ".pi/configs");
const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, "sillajje.json");
const tempDirs: string[] = [];

function cleanUp() {
	try {
		rmSync(GLOBAL_CONFIG_PATH);
	} catch {
		/* ok */
	}
	for (const d of tempDirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* ok */
		}
	}
}

function writeGlobalConfig(config: Record<string, unknown>) {
	mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
	writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config));
}

function writeProjectConfig(repoRoot: string, config: Record<string, unknown>) {
	const dir = join(repoRoot, ".pi/configs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "sillajje.json"), JSON.stringify(config));
}

describe("loadSillajjeConfig", () => {
	afterEach(cleanUp);

	// -------------------------------------------------------------------
	// Defaults
	// -------------------------------------------------------------------

	it("returns defaults when no config files exist", () => {
		cleanUp();
		const config = loadSillajjeConfig();
		expect(config.debug).toBe(false);
		expect(config.workspacesRoot).toBe(`${homedir()}/.pi/sillajje`);
		expect(config.subGeneratorModel).toBe("openai/gpt-4o-mini");
	});

	it("returns defaults when no config files exist with repoRoot", () => {
		const repoRoot = mkdtempSync(join(homedir(), ".pi/sillajje-config-test-"));
		tempDirs.push(repoRoot);
		const config = loadSillajjeConfig(repoRoot);
		expect(config.debug).toBe(false);
		expect(config.workspacesRoot).toBe(`${homedir()}/.pi/sillajje`);
		expect(config.subGeneratorModel).toBe("openai/gpt-4o-mini");
	});

	// -------------------------------------------------------------------
	// Global config
	// -------------------------------------------------------------------

	it("reads debug from global config", () => {
		writeGlobalConfig({ debug: true });
		const config = loadSillajjeConfig();
		expect(config.debug).toBe(true);
	});

	it("reads workspacesRoot from global config", () => {
		writeGlobalConfig({ workspacesRoot: "/tmp/sillajje-ws" });
		const config = loadSillajjeConfig();
		expect(config.workspacesRoot).toBe("/tmp/sillajje-ws");
	});

	it("reads subGeneratorModel from global config", () => {
		writeGlobalConfig({ subGeneratorModel: "claude-sonnet" });
		const config = loadSillajjeConfig();
		expect(config.subGeneratorModel).toBe("claude-sonnet");
	});

	it("partial global config merges with defaults", () => {
		writeGlobalConfig({ debug: true });
		const config = loadSillajjeConfig();
		expect(config.debug).toBe(true);
		expect(config.workspacesRoot).toBe(`${homedir()}/.pi/sillajje`);
		expect(config.subGeneratorModel).toBe("openai/gpt-4o-mini");
	});

	// -------------------------------------------------------------------
	// Project-local config takes precedence
	// -------------------------------------------------------------------

	it("project-local config overrides global config", () => {
		writeGlobalConfig({ debug: false, workspacesRoot: "/global" });
		const repoRoot = mkdtempSync(join(homedir(), ".pi/sillajje-config-test-"));
		tempDirs.push(repoRoot);
		writeProjectConfig(repoRoot, {
			debug: true,
			workspacesRoot: "/project",
		});

		const config = loadSillajjeConfig(repoRoot);
		expect(config.debug).toBe(true);
		expect(config.workspacesRoot).toBe("/project");
		// subGeneratorModel not in project config, falls to default
		expect(config.subGeneratorModel).toBe("openai/gpt-4o-mini");
	});

	it("project-local config is authoritative even when global is also present", () => {
		writeGlobalConfig({ debug: true });
		const repoRoot = mkdtempSync(join(homedir(), ".pi/sillajje-config-test-"));
		tempDirs.push(repoRoot);
		writeProjectConfig(repoRoot, { debug: false });

		const config = loadSillajjeConfig(repoRoot);
		// Project config says false, so false — global is ignored
		expect(config.debug).toBe(false);
	});

	// -------------------------------------------------------------------
	// Edge cases
	// -------------------------------------------------------------------

	it("returns defaults for empty config file", () => {
		writeGlobalConfig({});
		const config = loadSillajjeConfig();
		expect(config.debug).toBe(false);
		expect(config.workspacesRoot).toBe(`${homedir()}/.pi/sillajje`);
		expect(config.subGeneratorModel).toBe("openai/gpt-4o-mini");
	});

	it("returns defaults for malformed config file", () => {
		// Write something that isn't valid JSON
		try {
			writeFileSync(GLOBAL_CONFIG_PATH, "not-json");
		} catch {
			// ok
		}
		const config = loadSillajjeConfig();
		expect(config.debug).toBe(false);
		expect(config.workspacesRoot).toBe(`${homedir()}/.pi/sillajje`);
	});

	it("coerces non-boolean debug to false", () => {
		writeGlobalConfig({ debug: "yes" });
		const config = loadSillajjeConfig();
		expect(config.debug).toBe(false);
	});

	it("coerces null debug to false", () => {
		writeGlobalConfig({ debug: null });
		const config = loadSillajjeConfig();
		expect(config.debug).toBe(false);
	});

	it("falls through when project config directory doesn't exist", () => {
		writeGlobalConfig({ debug: true });
		const repoRoot = mkdtempSync(join(homedir(), ".pi/sillajje-config-test-"));
		tempDirs.push(repoRoot);
		// No .pi/configs/ in repoRoot

		const config = loadSillajjeConfig(repoRoot);
		expect(config.debug).toBe(true);
	});

	it("falls through when project config file is malformed", () => {
		writeGlobalConfig({ debug: true, workspacesRoot: "/global" });
		const repoRoot = mkdtempSync(join(homedir(), ".pi/sillajje-config-test-"));
		tempDirs.push(repoRoot);
		// Create a malformed file
		mkdirSync(join(repoRoot, ".pi/configs"), { recursive: true });
		writeFileSync(join(repoRoot, ".pi/configs/sillajje.json"), "broken");

		const config = loadSillajjeConfig(repoRoot);
		expect(config.debug).toBe(true);
		expect(config.workspacesRoot).toBe("/global");
	});
});
