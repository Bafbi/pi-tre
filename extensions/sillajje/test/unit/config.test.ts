import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Check, Default } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { loadSillajjeConfig, SillajjeConfigSchema } from "../../src/config";

const tempDirs: string[] = [];
const ENV_VAR = "SILLAJJE_POST_INIT";

function cleanUp() {
	for (const d of tempDirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* ok */
		}
	}
	delete process.env[ENV_VAR];
}

/** Create a fresh temp dir to serve as the global config dir. */
function makeConfigDir(): string {
	const configDir = mkdtempSync(join(tmpdir(), "sillajje-config-test-"));
	tempDirs.push(configDir);
	return configDir;
}

/** Create a fresh temp dir to serve as a jj repo root. */
function makeRepoRoot(): string {
	const repoRoot = mkdtempSync(join(tmpdir(), "sillajje-repo-test-"));
	tempDirs.push(repoRoot);
	return repoRoot;
}

/** Write a config file into the given global config dir. */
function writeGlobalConfig(configDir: string, config: Record<string, unknown>) {
	writeFileSync(join(configDir, "sillajje.json"), JSON.stringify(config));
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
		const configDir = makeConfigDir();
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.debug).toBe(false);
		expect(config.workspacesRoot).toBe(`${homedir()}/.pi/sillajje`);
		expect(config.subGeneratorModel).toBe("openai/gpt-4o-mini");
	});

	it("returns defaults when no config files exist with repoRoot", () => {
		const configDir = makeConfigDir();
		const repoRoot = makeRepoRoot();
		const config = loadSillajjeConfig(repoRoot, configDir);
		expect(config.debug).toBe(false);
		expect(config.workspacesRoot).toBe(`${homedir()}/.pi/sillajje`);
		expect(config.subGeneratorModel).toBe("openai/gpt-4o-mini");
	});

	// -------------------------------------------------------------------
	// Global config
	// -------------------------------------------------------------------

	it("reads debug from global config", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { debug: true });
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.debug).toBe(true);
	});

	it("reads workspacesRoot from global config", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { workspacesRoot: "/tmp/sillajje-ws" });
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.workspacesRoot).toBe("/tmp/sillajje-ws");
	});

	it("reads subGeneratorModel from global config", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { subGeneratorModel: "claude-sonnet" });
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.subGeneratorModel).toBe("claude-sonnet");
	});

	it("reads postInit from global config", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, {
			postInit: ["pnpm install", "mise install"],
		});
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.postInit).toEqual(["pnpm install", "mise install"]);
	});

	it("parses SILLAJJE_POST_INIT env var into postInit array", () => {
		const configDir = makeConfigDir();
		process.env[ENV_VAR] = "pnpm install; mise install";
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.postInit).toEqual(["pnpm install", "mise install"]);
	});

	it("SILLAJJE_POST_INIT env var overrides global config", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { postInit: ["from-config"] });
		process.env[ENV_VAR] = "from-env";
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.postInit).toEqual(["from-env"]);
	});

	it("SILLAJJE_POST_INIT env var overrides project config", () => {
		const configDir = makeConfigDir();
		const repoRoot = makeRepoRoot();
		writeProjectConfig(repoRoot, { postInit: ["from-project"] });
		process.env[ENV_VAR] = "from-env";
		const config = loadSillajjeConfig(repoRoot, configDir);
		expect(config.postInit).toEqual(["from-env"]);
	});

	it("empty SILLAJJE_POST_INIT env var yields empty array", () => {
		const configDir = makeConfigDir();
		process.env[ENV_VAR] = "";
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.postInit).toEqual([]);
	});

	it("whitespace-only entries in SILLAJJE_POST_INIT are trimmed", () => {
		const configDir = makeConfigDir();
		process.env[ENV_VAR] = "  pnpm install ;  mise install  ";
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.postInit).toEqual(["pnpm install", "mise install"]);
	});

	it("partial global config merges with defaults", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { debug: true });
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.debug).toBe(true);
		expect(config.workspacesRoot).toBe(`${homedir()}/.pi/sillajje`);
		expect(config.subGeneratorModel).toBe("openai/gpt-4o-mini");
	});

	// -------------------------------------------------------------------
	// Project-local config takes precedence
	// -------------------------------------------------------------------

	it("project-local config overrides global config", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, {
			debug: false,
			workspacesRoot: "/global",
		});
		const repoRoot = makeRepoRoot();
		writeProjectConfig(repoRoot, {
			debug: true,
			workspacesRoot: "/project",
		});

		const config = loadSillajjeConfig(repoRoot, configDir);
		expect(config.debug).toBe(true);
		expect(config.workspacesRoot).toBe("/project");
		// subGeneratorModel not in project config, falls to default
		expect(config.subGeneratorModel).toBe("openai/gpt-4o-mini");
	});

	it("project-local config is authoritative even when global is also present", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { debug: true });
		const repoRoot = makeRepoRoot();
		writeProjectConfig(repoRoot, { debug: false });

		const config = loadSillajjeConfig(repoRoot, configDir);
		// Project config says false, so false — global is ignored
		expect(config.debug).toBe(false);
	});

	// -------------------------------------------------------------------
	// Edge cases
	// -------------------------------------------------------------------

	it("returns defaults for empty config file", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, {});
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.debug).toBe(false);
		expect(config.workspacesRoot).toBe(`${homedir()}/.pi/sillajje`);
		expect(config.subGeneratorModel).toBe("openai/gpt-4o-mini");
	});

	it("returns defaults for malformed config file", () => {
		const configDir = makeConfigDir();
		// Write something that isn't valid JSON
		writeFileSync(join(configDir, "sillajje.json"), "not-json");
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.debug).toBe(false);
		expect(config.workspacesRoot).toBe(`${homedir()}/.pi/sillajje`);
	});

	it("coerces non-boolean debug to false", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { debug: "yes" });
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.debug).toBe(false);
	});

	it("coerces null debug to false", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { debug: null });
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.debug).toBe(false);
	});

	it("falls through when project config directory doesn't exist", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { debug: true });
		const repoRoot = makeRepoRoot();
		// No .pi/configs/ in repoRoot

		const config = loadSillajjeConfig(repoRoot, configDir);
		expect(config.debug).toBe(true);
	});

	it("falls through when project config file is malformed", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, {
			debug: true,
			workspacesRoot: "/global",
		});
		const repoRoot = makeRepoRoot();
		// Create a malformed file
		mkdirSync(join(repoRoot, ".pi/configs"), { recursive: true });
		writeFileSync(join(repoRoot, ".pi/configs/sillajje.json"), "broken");

		const config = loadSillajjeConfig(repoRoot, configDir);
		expect(config.debug).toBe(true);
		expect(config.workspacesRoot).toBe("/global");
	});

	// -------------------------------------------------------------------
	// message tree
	// -------------------------------------------------------------------

	it("missing message key applies all defaults", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { debug: true });
		const config = loadSillajjeConfig(undefined, configDir);
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
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { message: { header: "user_prompt" } });
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.message?.header).toBe("user_prompt");
	});

	it("message.body.trace.detail: step and decision are accepted", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, {
			message: { body: { trace: { detail: "step" } } },
		});
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.message?.body?.trace?.detail).toBe("step");

		writeGlobalConfig(configDir, {
			message: { body: { trace: { detail: "decision" } } },
		});
		const config2 = loadSillajjeConfig(undefined, configDir);
		expect(config2.message?.body?.trace?.detail).toBe("decision");
	});

	it("partial message.body fills missing fields with defaults", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, {
			message: { body: { user_prompt: false } },
		});
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.message?.body?.user_prompt).toBe(false);
		// Other fields default to true
		expect(config.message?.body?.response).toBe(true);
		expect(config.message?.body?.trace?.enabled).toBe(true);
		expect(config.message?.body?.meta?.enabled).toBe(true);
	});

	it("individual meta fields are independently toggleable", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, {
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
		const config = loadSillajjeConfig(undefined, configDir);
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
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, {});
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.subGenerator).toBeDefined();
		expect(config.subGenerator?.retry?.maxAttempts).toBe(3);
		expect(config.subGenerator?.timeoutMs).toBe(30_000);
	});

	it("partial subGenerator fills missing fields with defaults", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { subGenerator: { timeoutMs: 10_000 } });
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.subGenerator?.timeoutMs).toBe(10_000);
		expect(config.subGenerator?.retry?.maxAttempts).toBe(3);
	});

	it("subGenerator.retry.maxAttempts is configurable", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, {
			subGenerator: { retry: { maxAttempts: 5 } },
		});
		const config = loadSillajjeConfig(undefined, configDir);
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
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, {
			debug: true,
			message: { body: { trace: { detail: "low" } } },
		});
		const config = loadSillajjeConfig(undefined, configDir);
		// Falls back to defaults — trace.detail should be "high"
		expect(config.message?.body?.trace?.detail).toBe("high");
		// debug is also default (false) because the global config was invalid
		expect(config.debug).toBe(false);
	});

	// -------------------------------------------------------------------
	// Backward compatibility
	// -------------------------------------------------------------------

	it("config with only debug: true loads with all new defaults", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { debug: true });
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.debug).toBe(true);
		// All new fields are populated with defaults
		expect(config.message?.header).toBe("one_line");
		expect(config.message?.body?.trace?.enabled).toBe(true);
		expect(config.message?.body?.meta?.enabled).toBe(true);
		expect(config.subGenerator?.retry?.maxAttempts).toBe(3);
		expect(config.subGenerator?.timeoutMs).toBe(30_000);
	});

	it("legacy config with only old keys still works", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, {
			debug: false,
			workspacesRoot: "/custom/path",
			subGeneratorModel: "claude-sonnet",
		});
		const config = loadSillajjeConfig(undefined, configDir);
		expect(config.debug).toBe(false);
		expect(config.workspacesRoot).toBe("/custom/path");
		expect(config.subGeneratorModel).toBe("claude-sonnet");
		// New keys get defaults
		expect(config.message?.header).toBe("one_line");
		expect(config.subGenerator?.retry?.maxAttempts).toBe(3);
	});
});
