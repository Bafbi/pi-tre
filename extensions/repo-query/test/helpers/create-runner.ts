import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	discoverAndLoadExtensions,
	type ExecResult,
	type ExtensionAPI,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import { createRepoQueryExtension } from "../../src/index.js";

/** Entry point, resolved relative to this file so tests run from any cwd. */
const extensionPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../src/index.ts",
);

/** Create a temp directory for runner cwd or fixtures. */
export function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Remove temp directories, ignoring errors. */
export async function cleanupDirs(dirs: string[]): Promise<void> {
	for (const dir of dirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Load the extension through pi's loader and wrap it in a runner. */
export async function createRunner(cwd: string): Promise<ExtensionRunner> {
	const loaded = await discoverAndLoadExtensions([extensionPath], cwd, cwd);
	if (loaded.errors.length > 0) {
		throw new Error(
			`Extension load errors: ${loaded.errors.map((e) => e.error).join("; ")}`,
		);
	}

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

/** Real exec implementation matching pi's ExecResult contract. */
export async function testExec(
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
): Promise<ExecResult> {
	return new Promise<ExecResult>((resolve) => {
		const proc = spawn(command, args, {
			cwd: options?.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		const timer = options?.timeout
			? setTimeout(() => proc.kill("SIGKILL"), options.timeout)
			: undefined;
		proc.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({ stdout, stderr, code: code ?? 1, killed: false });
		});
		proc.on("error", () => {
			if (timer) clearTimeout(timer);
			resolve({ stdout, stderr, code: 1, killed: false });
		});
	});
}

export interface CapturedExtension {
	pi: ExtensionAPI;
	getTool: () =>
		| import("@earendil-works/pi-coding-agent").ToolDefinition
		| undefined;
}

/**
 * Build a mock ExtensionAPI that captures the registered tool and delegates
 * exec to real command execution (needed for genuine git clones in tests).
 */
export function captureExtension(
	overrides?: Parameters<typeof createRepoQueryExtension>[0],
): CapturedExtension {
	let tool:
		| import("@earendil-works/pi-coding-agent").ToolDefinition
		| undefined;
	const pi = {
		on: () => {},
		registerCommand: () => {},
		registerTool: (definition: { name: string }) => {
			if (definition.name === "repo_query") {
				tool =
					definition as import("@earendil-works/pi-coding-agent").ToolDefinition;
			}
		},
		exec: testExec,
	} as unknown as ExtensionAPI;
	createRepoQueryExtension(overrides)(pi);
	return {
		pi,
		getTool: () => tool,
	};
}

/** Minimal ExtensionContext covering what the extension actually reads. */
export function minimalContext(
	cwd: string,
): import("@earendil-works/pi-coding-agent").ExtensionContext {
	return {
		cwd,
		hasUI: false,
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionFile: () => join(cwd, "session.jsonl"),
			getBranch: () => [],
			getEntries: () => [],
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
}
