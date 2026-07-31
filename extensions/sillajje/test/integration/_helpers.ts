import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	discoverAndLoadExtensions,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect } from "vitest";
import { setTestSpawnFn } from "../../src/index.js";
import type { SpawnFn } from "../../src/sub-generator.js";

export const tempDirs: string[] = [];

afterEach(async () => {
	// Reset the sub-generator test seam so it never leaks into later tests.
	setTestSpawnFn(undefined);
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

export function makeRunnerCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "sillajje-ext-test-"));
	tempDirs.push(dir);
	return dir;
}

export function resolveExtensionPath(): string {
	const testDir = dirname(fileURLToPath(import.meta.url));
	return resolve(testDir, "../../src/index.ts");
}

export async function createRunner(cwd: string): Promise<ExtensionRunner> {
	const extensionPath = resolveExtensionPath();
	const loaded = await discoverAndLoadExtensions([extensionPath], cwd, cwd);
	expect(loaded.errors).toHaveLength(0);
	expect(loaded.extensions).toHaveLength(1);

	// Use a file-backed session so sillajje's TUI + non-ephemeral gate passes.
	const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(cwd, "auth.json"),
		allowModelNetwork: false,
	});
	const modelRegistry = new ModelRegistry(modelRuntime);
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		cwd,
		sessionManager,
		modelRegistry,
	);

	// Set TUI mode with a minimal UI mock so sillajje's mode gate passes.
	runner.setUIContext(
		{
			setStatus: () => {},
			notify: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
		} as unknown as Parameters<typeof runner.setUIContext>[0],
		"tui",
	);

	return runner;
}

/** Requires jj on PATH — skips when absent. */
export function describeJj(name: string, fn: () => void): void {
	let jjAvailable = false;
	try {
		execSync("jj --version", { stdio: "pipe" });
		jjAvailable = true;
	} catch {
		/* jj not on PATH */
	}
	(jjAvailable ? describe : describe.skip)(name, fn);
}

/**
 * Canned sub-generator output for integration tests.
 *
 * The header sub-generator reads the first stdout line as the subject; the
 * trace sub-generator reads the whole stdout. Installed by default (see
 * `installDefaultSubGeneratorMock`) so change stamping never spawns a real
 * `pi -p` subprocess during tests.
 */
export const defaultSubGeneratorMock: SpawnFn = async () => ({
	code: 0,
	stdout: "test subject\ntest trace narrative",
	stderr: "",
});

/**
 * Install the canned sub-generator for the duration of a test.
 * The shared `afterEach` in this module resets the seam afterwards.
 */
export function installDefaultSubGeneratorMock(): void {
	setTestSpawnFn(defaultSubGeneratorMock);
}
