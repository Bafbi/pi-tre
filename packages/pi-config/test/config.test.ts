import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadExtensionConfig } from "../src/index.js";

const NAME = "test-ext";

/** A schema with nested defaults and an array, to exercise merge and Default. */
const TestSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String()),
		name: Type.Optional(Type.String({ default: "default-name" })),
		posts: Type.Optional(Type.Array(Type.String(), { default: [] })),
		message: Type.Optional(
			Type.Object(
				{
					header: Type.Optional(Type.String({ default: "one_line" })),
					body: Type.Optional(
						Type.Object(
							{
								trace: Type.Optional(
									Type.Boolean({ default: true }),
								),
								response: Type.Optional(
									Type.Boolean({ default: true }),
								),
							},
							{ default: {} },
						),
					),
				},
				{ default: {} },
			),
		),
	},
	{ additionalProperties: false },
);

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeGlobal(configDir: string, config: unknown): void {
	writeFileSync(join(configDir, `${NAME}.json`), JSON.stringify(config));
}

function writeProject(repoRoot: string, config: unknown): void {
	const dir = join(repoRoot, ".pi", "configs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${NAME}.json`), JSON.stringify(config));
}

/** Capture console.error lines so warning behavior can be asserted. */
function captureWarnings(): string[] {
	const warnings: string[] = [];
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	});
	return warnings;
}

beforeEach(() => {
	vi.unstubAllEnvs();
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("loadExtensionConfig", () => {
	it("applies schema defaults when no files exist", () => {
		const configDir = makeTempDir("pi-config-empty-");
		const config = loadExtensionConfig({
			name: NAME,
			schema: TestSchema,
			configDir,
		});

		expect(config).toEqual({
			name: "default-name",
			posts: [],
			message: {
				header: "one_line",
				body: { trace: true, response: true },
			},
		});
	});

	it("reads the global layer", () => {
		const configDir = makeTempDir("pi-config-global-");
		writeGlobal(configDir, { name: "from-global" });

		const config = loadExtensionConfig({
			name: NAME,
			schema: TestSchema,
			configDir,
		});

		expect(config.name).toBe("from-global");
	});

	it("honors PI_CODING_AGENT_DIR for the global layer", () => {
		const agentDir = makeTempDir("pi-config-agent-");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		mkdirSync(join(agentDir, "configs"), { recursive: true });
		writeGlobal(join(agentDir, "configs"), { name: "from-agent-dir" });

		const config = loadExtensionConfig({ name: NAME, schema: TestSchema });

		expect(config.name).toBe("from-agent-dir");
	});

	it("reads the project layer when trusted", () => {
		const configDir = makeTempDir("pi-config-proj-global-");
		const repoRoot = makeTempDir("pi-config-proj-repo-");
		writeProject(repoRoot, { name: "from-project" });

		const config = loadExtensionConfig({
			name: NAME,
			schema: TestSchema,
			repoRoot,
			configDir,
			trusted: true,
		});

		expect(config.name).toBe("from-project");
	});

	it("ignores the project layer when not trusted", () => {
		const configDir = makeTempDir("pi-config-untrusted-global-");
		const repoRoot = makeTempDir("pi-config-untrusted-repo-");
		writeGlobal(configDir, { name: "from-global" });
		writeProject(repoRoot, { name: "from-project" });

		const config = loadExtensionConfig({
			name: NAME,
			schema: TestSchema,
			repoRoot,
			configDir,
		});

		expect(config.name).toBe("from-global");
	});

	it("deep-merges the project over the global per leaf", () => {
		const configDir = makeTempDir("pi-config-merge-global-");
		const repoRoot = makeTempDir("pi-config-merge-repo-");
		writeGlobal(configDir, {
			message: { header: "global", body: { response: false } },
		});
		writeProject(repoRoot, { message: { header: "project" } });

		const config = loadExtensionConfig({
			name: NAME,
			schema: TestSchema,
			repoRoot,
			configDir,
			trusted: true,
		});

		expect(config.message?.header).toBe("project");
		// The global sibling survives under the same object.
		expect(config.message?.body?.response).toBe(false);
		// An untouched default still applies.
		expect(config.message?.body?.trace).toBe(true);
	});

	it("replaces arrays instead of concatenating them", () => {
		const configDir = makeTempDir("pi-config-array-global-");
		const repoRoot = makeTempDir("pi-config-array-repo-");
		writeGlobal(configDir, { posts: ["global"] });
		writeProject(repoRoot, { posts: ["project"] });

		const config = loadExtensionConfig({
			name: NAME,
			schema: TestSchema,
			repoRoot,
			configDir,
			trusted: true,
		});

		expect(config.posts).toEqual(["project"]);
	});

	it("strips unknown keys and warns about each one", () => {
		const configDir = makeTempDir("pi-config-unknown-");
		const warnings = captureWarnings();
		writeGlobal(configDir, {
			name: "kept",
			typo: 1,
			message: { header: "h", bogus: true },
		});

		const config = loadExtensionConfig({
			name: NAME,
			schema: TestSchema,
			configDir,
		});

		expect(config.name).toBe("kept");
		expect(config).not.toHaveProperty("typo");
		expect(config.message).not.toHaveProperty("bogus");
		expect(
			warnings.some((line) =>
				line.includes('unknown key "typo" ignored'),
			),
		).toBe(true);
		expect(
			warnings.some((line) =>
				line.includes('unknown key "message.bogus" ignored'),
			),
		).toBe(true);
	});

	it("skips an invalid layer and keeps the valid one", () => {
		const configDir = makeTempDir("pi-config-invalid-global-");
		const repoRoot = makeTempDir("pi-config-invalid-repo-");
		const warnings = captureWarnings();
		writeGlobal(configDir, { name: "from-global" });
		writeProject(repoRoot, { name: 42 });

		const config = loadExtensionConfig({
			name: NAME,
			schema: TestSchema,
			repoRoot,
			configDir,
			trusted: true,
		});

		expect(config.name).toBe("from-global");
		expect(
			warnings.some((line) => line.includes("failed validation")),
		).toBe(true);
	});

	it("falls back to defaults when a file is not a JSON object", () => {
		const configDir = makeTempDir("pi-config-nonobject-");
		const warnings = captureWarnings();
		writeFileSync(join(configDir, `${NAME}.json`), "[1, 2, 3]");

		const config = loadExtensionConfig({
			name: NAME,
			schema: TestSchema,
			configDir,
		});

		expect(config.name).toBe("default-name");
		expect(
			warnings.some((line) =>
				line.includes("must contain a JSON object"),
			),
		).toBe(true);
	});

	it("falls back to the other layer when one file is malformed JSON", () => {
		const configDir = makeTempDir("pi-config-malformed-global-");
		const repoRoot = makeTempDir("pi-config-malformed-repo-");
		const warnings = captureWarnings();
		writeGlobal(configDir, { name: "from-global" });
		const dir = join(repoRoot, ".pi", "configs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${NAME}.json`), "{not json");

		const config = loadExtensionConfig({
			name: NAME,
			schema: TestSchema,
			repoRoot,
			configDir,
			trusted: true,
		});

		expect(config.name).toBe("from-global");
		expect(
			warnings.some((line) => line.includes("is not valid JSON")),
		).toBe(true);
	});
});
