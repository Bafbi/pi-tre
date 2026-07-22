import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	discoverAndLoadExtensions,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const extensionPath = resolve(
	process.cwd(),
	"extensions/leaf-copy/src/index.ts",
);
const tempDirs: string[] = [];

function makeRunnerCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "leaf-copy-ext-test-"));
	tempDirs.push(dir);
	return dir;
}

async function createRunner(): Promise<ExtensionRunner> {
	const cwd = makeRunnerCwd();
	const loaded = await discoverAndLoadExtensions([extensionPath], cwd, cwd);
	expect(loaded.errors).toHaveLength(0);
	expect(loaded.extensions).toHaveLength(1);

	const sessionManager = SessionManager.inMemory();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(cwd, "auth.json"),
		allowModelNetwork: false,
	});
	const modelRegistry = new ModelRegistry(modelRuntime);
	return new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		cwd,
		sessionManager,
		modelRegistry,
	);
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("leaf-copy extension", () => {
	it("loads without errors", async () => {
		const runner = await createRunner();
		expect(runner.getExtensionPaths()).toContain(extensionPath);
	});

	it("registers the ctrl+shift+c shortcut", async () => {
		const runner = await createRunner();
		const shortcuts = runner.getShortcuts({} as any);
		const found = Array.from(shortcuts.entries()).find(([, s]) =>
			s.description?.includes("Copy editor text or last leaf message"),
		);
		expect(found).toBeDefined();
		expect(found?.[0]).toBe("ctrl+shift+c");
	});

	it("does not register any command", async () => {
		const runner = await createRunner();
		const commands = runner.getRegisteredCommands();
		expect(commands).toHaveLength(0);
	});

	it("does not register any tool", async () => {
		const runner = await createRunner();
		const tools = runner.getAllRegisteredTools();
		expect(tools).toHaveLength(0);
	});
});
