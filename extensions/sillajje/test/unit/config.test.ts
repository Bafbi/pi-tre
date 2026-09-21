import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "@sinclair/typebox/value";
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
		const config = loadSillajjeConfig({ configDir });
		expect(config.debug).toBe(false);
		expect(config.workspacesRoot).toBe(`${homedir()}/.pi/sillajje`);
		expect(config.subGeneratorModel).toBe("openai/gpt-4o-mini");
		expect(config.vcsGuard).toBe(true);
		expect(config.postInit).toEqual([]);
	});

	// -------------------------------------------------------------------
	// Global config
	// -------------------------------------------------------------------

	it("reads scalar values from the global config", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, {
			debug: true,
			workspacesRoot: "/tmp/sillajje-ws",
			subGeneratorModel: "claude-sonnet",
			vcsGuard: false,
			postInit: ["pnpm install", "mise install"],
		});

		const config = loadSillajjeConfig({ configDir });

		expect(config.debug).toBe(true);
		expect(config.workspacesRoot).toBe("/tmp/sillajje-ws");
		expect(config.subGeneratorModel).toBe("claude-sonnet");
		expect(config.vcsGuard).toBe(false);
		expect(config.postInit).toEqual(["pnpm install", "mise install"]);
	});

	it("partial global config merges with defaults", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { debug: true });

		const config = loadSillajjeConfig({ configDir });

		expect(config.debug).toBe(true);
		expect(config.workspacesRoot).toBe(`${homedir()}/.pi/sillajje`);
		expect(config.subGeneratorModel).toBe("openai/gpt-4o-mini");
	});

	// -------------------------------------------------------------------
	// Project config and trust
	// -------------------------------------------------------------------

	it("reads the project config when trusted", () => {
		const configDir = makeConfigDir();
		const repoRoot = makeRepoRoot();
		writeGlobalConfig(configDir, { debug: false });
		writeProjectConfig(repoRoot, {
			debug: true,
			workspacesRoot: "/project",
		});

		const config = loadSillajjeConfig({
			repoRoot,
			configDir,
			trusted: true,
		});

		expect(config.debug).toBe(true);
		expect(config.workspacesRoot).toBe("/project");
	});

	it("ignores the project config when the project is not trusted", () => {
		const configDir = makeConfigDir();
		const repoRoot = makeRepoRoot();
		writeGlobalConfig(configDir, { debug: false });
		writeProjectConfig(repoRoot, { debug: true, postInit: ["rm -rf /"] });

		const config = loadSillajjeConfig({ repoRoot, configDir });

		expect(config.debug).toBe(false);
		expect(config.postInit).toEqual([]);
	});

	it("merges nested message config with the project winning per leaf", () => {
		const configDir = makeConfigDir();
		const repoRoot = makeRepoRoot();
		writeGlobalConfig(configDir, {
			message: { body: { trace: { detail: "step" } } },
		});
		writeProjectConfig(repoRoot, { message: { header: "user_prompt" } });

		const config = loadSillajjeConfig({
			repoRoot,
			configDir,
			trusted: true,
		});

		expect(config.message?.header).toBe("user_prompt");
		expect(config.message?.body?.trace?.detail).toBe("step");
	});

	// -------------------------------------------------------------------
	// Env override
	// -------------------------------------------------------------------

	it("parses SILLAJJE_POST_INIT into a postInit array", () => {
		const configDir = makeConfigDir();
		process.env[ENV_VAR] = "  pnpm install ;  mise install  ";
		const config = loadSillajjeConfig({ configDir });
		expect(config.postInit).toEqual(["pnpm install", "mise install"]);
	});

	it("SILLAJJE_POST_INIT overrides the global config", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { postInit: ["from-config"] });
		process.env[ENV_VAR] = "from-env";

		const config = loadSillajjeConfig({ configDir });

		expect(config.postInit).toEqual(["from-env"]);
	});

	it("an empty SILLAJJE_POST_INIT yields an empty array", () => {
		const configDir = makeConfigDir();
		process.env[ENV_VAR] = "";
		const config = loadSillajjeConfig({ configDir });
		expect(config.postInit).toEqual([]);
	});

	// -------------------------------------------------------------------
	// message tree
	// -------------------------------------------------------------------

	it("missing message key applies all defaults", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { debug: true });

		const config = loadSillajjeConfig({ configDir });

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

	it("partial message.body fills the missing fields with defaults", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, {
			message: { body: { user_prompt: false } },
		});

		const config = loadSillajjeConfig({ configDir });

		expect(config.message?.body?.user_prompt).toBe(false);
		expect(config.message?.body?.response).toBe(true);
		expect(config.message?.body?.trace?.enabled).toBe(true);
	});

	// -------------------------------------------------------------------
	// subGenerator tree
	// -------------------------------------------------------------------

	it("missing subGenerator key applies defaults", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, {});

		const config = loadSillajjeConfig({ configDir });

		expect(config.subGenerator?.retry?.maxAttempts).toBe(3);
		expect(config.subGenerator?.timeoutMs).toBe(30_000);
	});

	it("partial subGenerator fills the missing fields with defaults", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, { subGenerator: { timeoutMs: 10_000 } });

		const config = loadSillajjeConfig({ configDir });

		expect(config.subGenerator?.timeoutMs).toBe(10_000);
		expect(config.subGenerator?.retry?.maxAttempts).toBe(3);
	});

	// -------------------------------------------------------------------
	// Invalid input
	// -------------------------------------------------------------------

	it("returns defaults for a malformed global config file", () => {
		const configDir = makeConfigDir();
		writeFileSync(join(configDir, "sillajje.json"), "not-json");

		const config = loadSillajjeConfig({ configDir });

		expect(config.debug).toBe(false);
		expect(config.workspacesRoot).toBe(`${homedir()}/.pi/sillajje`);
	});

	it("trace.detail rejects invalid values via the schema", () => {
		const invalid = {
			message: { body: { trace: { detail: "low" } } },
		};
		expect(Check(SillajjeConfigSchema, invalid)).toBe(false);
	});

	it("an invalid global config falls back to defaults entirely", () => {
		const configDir = makeConfigDir();
		writeGlobalConfig(configDir, {
			debug: true,
			message: { body: { trace: { detail: "low" } } },
		});

		const config = loadSillajjeConfig({ configDir });

		expect(config.message?.body?.trace?.detail).toBe("high");
		expect(config.debug).toBe(false);
	});
});
