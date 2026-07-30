import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Check, Default } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { loadSillajjeConfig, SillajjeConfigSchema } from "../../src/config";

const GLOBAL_CONFIG_DIR = join(homedir(), ".pi/configs");
const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, "sillajje.json");
const tempDirs: string[] = [];
const ENV_VAR = "SILLAJJE_POST_INIT";

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
	delete process.env[ENV_VAR];
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
		const repoRoot = mkdtempSync(
			join(homedir(), ".pi/sillajje-config-test-"),
		);
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

	it("reads postInit from global config", () => {
		writeGlobalConfig({
			postInit: ["pnpm install", "mise install"],
		});
		const config = loadSillajjeConfig();
		expect(config.postInit).toEqual(["pnpm install", "mise install"]);
	});

	it("parses SILLAJJE_POST_INIT env var into postInit array", () => {
		process.env[ENV_VAR] = "pnpm install; mise install";
		const config = loadSillajjeConfig();
		expect(config.postInit).toEqual(["pnpm install", "mise install"]);
	});

	it("SILLAJJE_POST_INIT env var overrides global config", () => {
		writeGlobalConfig({ postInit: ["from-config"] });
		process.env[ENV_VAR] = "from-env";
		const config = loadSillajjeConfig();
		expect(config.postInit).toEqual(["from-env"]);
	});

	it("SILLAJJE_POST_INIT env var overrides project config", () => {
		const repoRoot = mkdtempSync(
			join(homedir(), ".pi/sillajje-config-test-"),
		);
		tempDirs.push(repoRoot);
		writeProjectConfig(repoRoot, { postInit: ["from-project"] });
		process.env[ENV_VAR] = "from-env";
		const config = loadSillajjeConfig(repoRoot);
		expect(config.postInit).toEqual(["from-env"]);
	});

	it("empty SILLAJJE_POST_INIT env var yields empty array", () => {
		process.env[ENV_VAR] = "";
		const config = loadSillajjeConfig();
		expect(config.postInit).toEqual([]);
	});

	it("whitespace-only entries in SILLAJJE_POST_INIT are trimmed", () => {
		process.env[ENV_VAR] = "  pnpm install ;  mise install  ";
		const config = loadSillajjeConfig();
		expect(config.postInit).toEqual(["pnpm install", "mise install"]);
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
		const repoRoot = mkdtempSync(
			join(homedir(), ".pi/sillajje-config-test-"),
		);
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
		const repoRoot = mkdtempSync(
			join(homedir(), ".pi/sillajje-config-test-"),
		);
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
		const repoRoot = mkdtempSync(
			join(homedir(), ".pi/sillajje-config-test-"),
		);
		tempDirs.push(repoRoot);
		// No .pi/configs/ in repoRoot

		const config = loadSillajjeConfig(repoRoot);
		expect(config.debug).toBe(true);
	});

	it("falls through when project config file is malformed", () => {
		writeGlobalConfig({ debug: true, workspacesRoot: "/global" });
		const repoRoot = mkdtempSync(
			join(homedir(), ".pi/sillajje-config-test-"),
		);
		tempDirs.push(repoRoot);
		// Create a malformed file
		mkdirSync(join(repoRoot, ".pi/configs"), { recursive: true });
		writeFileSync(join(repoRoot, ".pi/configs/sillajje.json"), "broken");

		const config = loadSillajjeConfig(repoRoot);
		expect(config.debug).toBe(true);
		expect(config.workspacesRoot).toBe("/global");
	});

	// -------------------------------------------------------------------
	// message tree
	// -------------------------------------------------------------------

	it("missing message key applies all defaults", () => {
		writeGlobalConfig({ debug: true });
		const config = loadSillajjeConfig();
		expect(config.message).toBeDefined();
		expect(config.message?.header).toBe("one_line");
		expect(config.message?.body?.trace?.enabled).toBe(true);
		expect(config.message?.body?.trace?.detail).toBe("high");
		expect(config.message?.body?.meta?.enabled).toBe(true);
		expect(config.message?.body?.meta?.tools).toBe(true);
		expect(config.message?.body?.meta?.call_count).toBe(true);
		expect(config.message?.body?.meta?.elapsed).toBe(true);
		expect(config.message?.body?.meta?.thinking_blocks).toBe(true);
		expect(config.message?.body?.user_prompt).toBe(true);
		expect(config.message?.body?.response).toBe(true);
	});

	it("message.header: user_prompt is accepted", () => {
		writeGlobalConfig({ message: { header: "user_prompt" } });
		const config = loadSillajjeConfig();
		expect(config.message?.header).toBe("user_prompt");
	});

	it("message.body.trace.detail: step and decision are accepted", () => {
		writeGlobalConfig({
			message: { body: { trace: { detail: "step" } } },
		});
		const config = loadSillajjeConfig();
		expect(config.message?.body?.trace?.detail).toBe("step");

		writeGlobalConfig({
			message: { body: { trace: { detail: "decision" } } },
		});
		const config2 = loadSillajjeConfig();
		expect(config2.message?.body?.trace?.detail).toBe("decision");
	});

	it("partial message.body fills missing fields with defaults", () => {
		writeGlobalConfig({
			message: { body: { user_prompt: false } },
		});
		const config = loadSillajjeConfig();
		expect(config.message?.body?.user_prompt).toBe(false);
		// Other fields default to true
		expect(config.message?.body?.response).toBe(true);
		expect(config.message?.body?.trace?.enabled).toBe(true);
		expect(config.message?.body?.meta?.enabled).toBe(true);
	});

	it("individual meta fields are independently toggleable", () => {
		writeGlobalConfig({
			message: {
				body: {
					meta: {
						enabled: true,
						tools: false,
						call_count: false,
					},
				},
			},
		});
		const config = loadSillajjeConfig();
		expect(config.message?.body?.meta?.enabled).toBe(true);
		expect(config.message?.body?.meta?.tools).toBe(false);
		expect(config.message?.body?.meta?.call_count).toBe(false);
		// Rest default to true
		expect(config.message?.body?.meta?.elapsed).toBe(true);
		expect(config.message?.body?.meta?.thinking_blocks).toBe(true);
	});

	// -------------------------------------------------------------------
	// subGenerator tree
	// -------------------------------------------------------------------

	it("missing subGenerator key applies defaults", () => {
		writeGlobalConfig({});
		const config = loadSillajjeConfig();
		expect(config.subGenerator).toBeDefined();
		expect(config.subGenerator?.retry?.maxAttempts).toBe(3);
		expect(config.subGenerator?.timeoutMs).toBe(30_000);
	});

	it("partial subGenerator fills missing fields with defaults", () => {
		writeGlobalConfig({ subGenerator: { timeoutMs: 10_000 } });
		const config = loadSillajjeConfig();
		expect(config.subGenerator?.timeoutMs).toBe(10_000);
		expect(config.subGenerator?.retry?.maxAttempts).toBe(3);
	});

	it("subGenerator.retry.maxAttempts is configurable", () => {
		writeGlobalConfig({
			subGenerator: { retry: { maxAttempts: 5 } },
		});
		const config = loadSillajjeConfig();
		expect(config.subGenerator?.retry?.maxAttempts).toBe(5);
	});

	// -------------------------------------------------------------------
	// Schema validation — trace.detail rejects invalid values
	// -------------------------------------------------------------------

	it("trace.detail rejects invalid values via schema", () => {
		// Inject directly through Check() to test schema-level validation
		const valid = Default(SillajjeConfigSchema, {
			message: { body: { trace: { detail: "high" } } },
		});
		expect(Check(SillajjeConfigSchema, valid)).toBe(true);

		const invalid = {
			message: { body: { trace: { detail: "low" } } },
		};
		expect(Check(SillajjeConfigSchema, invalid)).toBe(false);
	});

	it("trace.detail rejects 'low' through config loading (falls back to defaults)", () => {
		// When an invalid value is stored in the global config, readConfigFile
		// returns undefined and loadSillajjeConfig falls through to DEFAULTS.
		// We set a known value in global to verify fallback is happening.
		writeGlobalConfig({
			debug: true,
			message: { body: { trace: { detail: "low" } } },
		});
		const config = loadSillajjeConfig();
		// Falls back to defaults — trace.detail should be "high"
		expect(config.message?.body?.trace?.detail).toBe("high");
		// debug is also default (false) because the global config was invalid
		expect(config.debug).toBe(false);
	});

	// -------------------------------------------------------------------
	// Backward compatibility
	// -------------------------------------------------------------------

	it("config with only debug: true loads with all new defaults", () => {
		writeGlobalConfig({ debug: true });
		const config = loadSillajjeConfig();
		expect(config.debug).toBe(true);
		// All new fields are populated with defaults
		expect(config.message?.header).toBe("one_line");
		expect(config.message?.body?.trace?.enabled).toBe(true);
		expect(config.message?.body?.meta?.enabled).toBe(true);
		expect(config.subGenerator?.retry?.maxAttempts).toBe(3);
		expect(config.subGenerator?.timeoutMs).toBe(30_000);
	});

	it("legacy config with only old keys still works", () => {
		writeGlobalConfig({
			debug: false,
			workspacesRoot: "/custom/path",
			subGeneratorModel: "claude-sonnet",
		});
		const config = loadSillajjeConfig();
		expect(config.debug).toBe(false);
		expect(config.workspacesRoot).toBe("/custom/path");
		expect(config.subGeneratorModel).toBe("claude-sonnet");
		// New keys get defaults
		expect(config.message?.header).toBe("one_line");
		expect(config.subGenerator?.retry?.maxAttempts).toBe(3);
	});
});
