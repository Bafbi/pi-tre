import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import {
	discoverAndLoadExtensions,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { RunSubagent } from "@pi-tre/sillajje-core";
import type { ExecFn } from "@pi-tre/sillajje-jj";
import { defaultOwner } from "@pi-tre/sillajje-workspace";
import { afterEach, describe, expect } from "vitest";
import { setTestPorts } from "../../src/index.js";

export const tempDirs: string[] = [];

/**
 * The full SessionManager behind each runner, so tests can write to the
 * session log. The runner's context exposes only the read-only view.
 */
const sessionManagers = new WeakMap<ExtensionRunner, SessionManager>();

afterEach(async () => {
	// Reset the test seams so they never leak into later tests.
	setTestPorts({ run: undefined, exec: undefined });
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

export function makeRunnerCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "sillajje-ext-test-"));
	tempDirs.push(dir);
	return dir;
}

function resolveExtensionPath(): string {
	const testDir = dirname(fileURLToPath(import.meta.url));
	return resolve(testDir, "../../src/index.ts");
}

export async function createRunner(
	cwd: string,
	opts?: {
		/** Record UI notifications: each call appends `[message, type]`. */
		onNotify?: (msg: string, type: "info" | "warning" | "error") => void;
	},
): Promise<ExtensionRunner> {
	const extensionPath = resolveExtensionPath();
	const loaded = await discoverAndLoadExtensions([extensionPath], cwd, cwd);
	expect(loaded.errors).toHaveLength(0);
	expect(loaded.extensions).toHaveLength(1);

	// Use a file-backed session so sillajje's TUI + non-ephemeral gate passes.
	const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
	// Bind the one core action the adapter uses. The real host calls
	// `runner.bindCore`; the harness binds `appendEntry` directly so the
	// Stamp marker write works.
	loaded.runtime.appendEntry = (customType, data) =>
		sessionManager.appendCustomEntry(customType, data);
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
	sessionManagers.set(runner, sessionManager);

	// Set TUI mode with a minimal UI mock so sillajje's mode gate passes.
	runner.setUIContext(
		{
			setStatus: () => {},
			notify: opts?.onNotify ?? (() => {}),
			setEditorText: () => {},
			getEditorText: () => "",
		} as unknown as Parameters<typeof runner.setUIContext>[0],
		"tui",
	);

	return runner;
}

/** The full session manager behind a runner created by `createRunner`. */
export function getSessionManager(runner: ExtensionRunner): SessionManager {
	const sessionManager = sessionManagers.get(runner);
	if (!sessionManager) {
		throw new Error(
			"getSessionManager: runner was not created by createRunner",
		);
	}
	return sessionManager;
}

/**
 * Write a user prompt and an assistant response into the session log at the
 * current leaf. The adapter reads the Interaction transcript from the branch.
 */
export function recordInteraction(
	runner: ExtensionRunner,
	prompt: string,
	response: string,
): void {
	recordUserMessage(runner, prompt);
	recordAssistantMessage(runner, assistantMsg(response));
}

/** Write a user message into the session log at the current leaf. */
export function recordUserMessage(runner: ExtensionRunner, text: string): void {
	getSessionManager(runner).appendMessage({
		role: "user",
		content: text,
		timestamp: Date.now(),
	} as Message);
}

/** Write an assistant message into the session log at the current leaf. */
export function recordAssistantMessage(
	runner: ExtensionRunner,
	message: unknown,
): void {
	getSessionManager(runner).appendMessage(message as Message);
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

// ---------------------------------------------------------------------------
// Shared jj / session helpers
// ---------------------------------------------------------------------------

/** Run jj in the given directory (shell form so execSync honors the cwd). */
export function jj(args: string[], cwd: string): string {
	const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`);
	const cmd = ["jj", ...quoted].join(" ");
	return String(
		execSync(cmd, {
			cwd,
			encoding: "utf-8",
			stdio: "pipe",
		}),
	).trim();
}

/**
 * An `ExecFn` that runs every command against real jj (synchronously) except
 * the ones matching `failMatch`, which exit 1 with a fixed stderr. Records
 * every jj invocation in `calls` when given.
 */
export function failingJjExec(
	failMatch: (args: string[]) => boolean,
	calls?: Array<{ args: string[]; stderr: string }>,
): ExecFn {
	return (cmd, args, opts) => {
		if (cmd === "jj") calls?.push({ args, stderr: "" });
		if (cmd === "jj" && failMatch(args)) {
			if (calls) calls[calls.length - 1].stderr = "injected failure\n";
			return Promise.resolve({
				code: 1,
				stdout: "",
				stderr: "injected failure\n",
			});
		}
		const r = spawnSync(cmd, args, {
			cwd: opts?.cwd,
			encoding: "utf-8",
		});
		if (calls) calls[calls.length - 1].stderr = r.stderr ?? "";
		return Promise.resolve({
			code: r.status ?? 1,
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? "",
		});
	};
}

/** Get the session ID, throwing if undefined (it should always be set after session_start). */
export function getSessionId(runner: ExtensionRunner): string {
	const id = runner.createContext().sessionManager.getSessionId();
	if (!id) throw new Error("sessionId should be defined after session_start");
	return id;
}

/** Default workspace path for a given session (config workspacesRoot default). */
export function wsPath(repoRoot: string, sessionId: string): string {
	const repoSlug = repoRoot.split("/").pop();
	return `${homedir()}/.pi/sillajje/${repoSlug}/${sessionId}`;
}

/** The qualified session key: `<user>/<host>/<id>`. */
export function sessionKeyId(sessionId: string): string {
	return `${defaultOwner()}/${sessionId}`;
}

/** The namespaced bookmark for a session: `sillajje/<user>/<host>/<id>`. */
export function sessionBookmark(sessionId: string): string {
	return `sillajje/${sessionKeyId(sessionId)}`;
}

/** Create a fresh jj repo with one described root change and an empty `@`. */
export function initRepo(): string {
	const cwd = makeRunnerCwd();
	execSync("jj git init --config signing.backend=none", {
		cwd,
		stdio: "pipe",
	});
	writeFileSync(join(cwd, "README.md"), "# Test\n");
	execSync("jj describe -m 'initial'", { cwd, stdio: "pipe" });
	execSync("jj new -m 'work'", { cwd, stdio: "pipe" });
	return cwd;
}

/**
 * Invoke a `/sillajje:<subcommand>` command from a full invocation string
 * such as `"stamp -s @"`. The subcommand selects the registered command; the
 * rest is passed as its arguments.
 */
export async function runSillajje(
	runner: ExtensionRunner,
	invocation: string,
): Promise<void> {
	const [subcommand, ...rest] = invocation.trim().split(/\s+/);
	const cmd = runner.getCommand(`sillajje:${subcommand}`);
	expect(cmd).toBeDefined();
	await cmd?.handler(rest.join(" "), runner.createCommandContext());
}

/** Assistant message fixture, optionally with tool calls, thinking, or an error stop. */
export function assistantMsg(
	text: string,
	opts?: {
		toolCalls?: Array<{ id: string; name: string }>;
		thinking?: boolean;
		stopReason?: string;
		errorMessage?: string;
	},
) {
	const content: Array<{
		type: string;
		text?: string;
		thinking?: string;
		id?: string;
		name?: string;
	}> = [];
	if (opts?.thinking) {
		content.push({
			type: "thinking",
			thinking: "Let me think about this...",
		});
	}
	if (opts?.toolCalls) {
		for (const tc of opts.toolCalls) {
			content.push({ type: "toolCall", id: tc.id, name: tc.name });
		}
	}
	content.push({ type: "text", text });
	return {
		role: "assistant" as const,
		content,
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "test",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		stopReason: opts?.stopReason ?? "stop",
		errorMessage: opts?.errorMessage,
		timestamp: Date.now(),
	};
}

/**
 * Canned sub-generator output for integration tests.
 *
 * The header sub-generator reads the first stdout line as the subject; the
 * trace sub-generator reads the whole stdout. Installed by default (see
 * `installDefaultSubGeneratorMock`) so change stamping never runs a real
 * sub-generator during tests.
 */
const defaultSubGeneratorMock: RunSubagent = async () => ({
	text: "test subject\ntest trace narrative",
});

/**
 * Install the canned sub-generator for the duration of a test.
 * The shared `afterEach` in this module resets the seam afterwards.
 */
export function installDefaultSubGeneratorMock(): void {
	setTestPorts({ run: defaultSubGeneratorMock });
}
