import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
	type AssistantMessageInfo,
	emitAssistantMessage,
} from "./assistant-message.js";
import { createPushStream } from "./push-stream.js";
import type {
	SubagentBackend,
	SubagentEvent,
	SubagentSession,
	SubagentTask,
	SubagentUsage,
} from "./types.js";
import { zeroUsage } from "./types.js";

/** Default timeout for a child run: repo-query's proven 300 s. */
export const DEFAULT_PROCESS_TIMEOUT_MS = 300_000;

/** Default grace period between SIGTERM and SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 5_000;

/** Default hard cap on collected child stdout. */
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Minimal child-process surface the backend needs. A subset of
 * ChildProcess, so fakes are easy to write.
 */
export interface ProcessBackendSpawn {
	killed: boolean;
	stdout: { on(event: "data", cb: (data: Buffer) => void): unknown };
	stderr: { on(event: "data", cb: (data: Buffer) => void): unknown };
	on(event: "close", cb: (code: number | null) => void): unknown;
	on(event: "error", cb: (err: Error) => void): unknown;
	kill(signal?: NodeJS.Signals): boolean;
}

export type ProcessSpawnFn = (
	command: string,
	args: string[],
	opts: { cwd: string },
) => ProcessBackendSpawn;

export interface ProcessBackendOptions {
	/** Spawn override for tests. Default: `node:child_process` spawn, no shell. */
	spawn?: ProcessSpawnFn | undefined;
	/** Grace period between SIGTERM and SIGKILL. Default: `DEFAULT_KILL_GRACE_MS`. */
	killGraceMs?: number | undefined;
	/** Hard cap on collected child stdout. Default: `DEFAULT_MAX_OUTPUT_BYTES`. */
	maxOutputBytes?: number | undefined;
}

interface ProtocolMessage {
	role: string;
	content: Array<{ type: string; text: string }>;
	usage?: Record<string, unknown>;
	stopReason?: string;
	errorMessage?: string;
}

interface LineHandlers {
	onText: (text: string, kind: "delta" | "full") => void;
	onThinking: (text: string, kind: "delta" | "full") => void;
	onAssistantMessage?: (info: AssistantMessageInfo) => void;
}

/** Parse one JSON-lines protocol event and dispatch to the handlers. */
function processLine(line: string, handlers: LineHandlers): void {
	if (!line.trim()) return;
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}

	if (!isObject(event)) return;

	if (event.type === "message_update" && hasAssistantMessageEvent(event)) {
		const ame = event.assistantMessageEvent as {
			type: string;
			delta?: string;
		};
		if (ame.type === "text_delta" && typeof ame.delta === "string") {
			handlers.onText(ame.delta, "delta");
		} else if (
			ame.type === "thinking_delta" &&
			typeof ame.delta === "string"
		) {
			handlers.onThinking(ame.delta, "delta");
		}
	}

	if (event.type === "message_end" && event.message) {
		const msg = event.message as ProtocolMessage;
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			handlers.onAssistantMessage?.({
				content: msg.content,
				usage: isObject(msg.usage)
					? (msg.usage as AssistantMessageInfo["usage"])
					: undefined,
				stopReason:
					typeof msg.stopReason === "string"
						? msg.stopReason
						: undefined,
				errorMessage:
					typeof msg.errorMessage === "string"
						? msg.errorMessage
						: undefined,
			});
		}
	}
}

interface ExitInfo {
	code: number;
	timedOut: boolean;
	aborted: boolean;
	overflow: boolean;
	stderr: string;
	spawnError?: string | undefined;
}

/**
 * A backend that runs a child, headless pi process.
 *
 * Ported from repo-query's explorer lifecycle: the task prompt goes out as
 * the positional user message; `systemPrompt` (when given) goes via a temp
 * file and `--append-system-prompt`; stdout is parsed line by line into
 * typed events; a timeout or abort escalates SIGTERM to SIGKILL after the
 * grace period; the abort listener is removed on normal completion; stdout
 * is capped at `maxOutputBytes`.
 */
export function createProcessBackend(
	options?: ProcessBackendOptions,
): SubagentBackend {
	const childSpawn = options?.spawn ?? defaultSpawn;
	const killGraceMs = options?.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
	const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

	return {
		run(task: SubagentTask): SubagentSession {
			const push = createPushStream<SubagentEvent>();
			const timeoutMs = task.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;

			const usage: SubagentUsage = zeroUsage();
			let resolveUsage: (u: SubagentUsage) => void = () => {};
			const usagePromise = new Promise<SubagentUsage>((resolve) => {
				resolveUsage = resolve;
			});

			let removeAbortListener = () => {};

			// Resolves when the run has fully ended: the exit event is pushed,
			// the stream is closed, and usage has settled. `abort()` waits on
			// this so awaiting it means the run is over, matching the in-process
			// backend and the shared session contract.
			let resolveRunDone: () => void = () => {};
			const runDone = new Promise<void>((resolve) => {
				resolveRunDone = resolve;
			});

			// Kill the child with escalation, once it exists. The spawn body
			// installs this; `abort()` before spawn records the intent.
			let killChild: (() => void) | undefined;
			let abortIntent = false;
			// True when the run ends through the abort signal or `abort()`. The
			// signal listener sets it too; `abort()` sets it up front so the exit
			// event reports the abort even before the child exists.
			let wasAborted = false;

			const session: SubagentSession = {
				events: push.stream,
				usage: () => usagePromise,
				abort: () => {
					abortIntent = true;
					wasAborted = true;
					killChild?.();
					return runDone;
				},
			};

			void (async () => {
				let tmpDir: string | undefined;
				let didExit = false;
				let timeoutFired = false;
				let overflow = false;
				let spawnErrorMessage: string | undefined;
				let graceTimer: ReturnType<typeof setTimeout> | undefined;

				const timeoutId = setTimeout(() => {
					timeoutFired = true;
					killChild?.();
				}, timeoutMs);

				// Send SIGTERM, then SIGKILL if the process is still alive after
				// the grace period. Checks didExit, not proc.killed — killed is
				// true the moment SIGTERM is sent.
				const killWithEscalation = (proc: ProcessBackendSpawn) => {
					proc.kill("SIGTERM");
					graceTimer = setTimeout(() => {
						if (!didExit) proc.kill("SIGKILL");
					}, killGraceMs);
				};

				const finish = (exit: ExitInfo): void => {
					if (didExit) return;
					didExit = true;
					clearTimeout(timeoutId);
					if (graceTimer) clearTimeout(graceTimer);
					removeAbortListener();
					void (async () => {
						// The temp prompt file is gone before the caller sees the
						// exit event.
						if (tmpDir) {
							await rm(tmpDir, {
								recursive: true,
								force: true,
							}).catch(() => {});
						}
						push.push({ type: "exit", ...exit });
						push.close();
						resolveUsage({ ...usage });
						resolveRunDone();
					})();
				};

				try {
					const args = ["--mode", "json", "-p", "--no-session"];

					// An empty allowlist means "no tools" in both backends; the
					// CLI spelling is --no-tools.
					if (task.tools?.length === 0) {
						args.push("--no-tools");
					} else if (task.tools && task.tools.length > 0) {
						args.push("--tools", task.tools.join(","));
					}
					if (task.excludeTools && task.excludeTools.length > 0) {
						args.push(
							"--exclude-tools",
							task.excludeTools.join(","),
						);
					}
					if (task.thinkingLevel) {
						args.push("--thinking", task.thinkingLevel);
					}
					if (task.model) {
						args.push(
							"--model",
							typeof task.model === "string"
								? task.model
								: `${task.model.provider}/${task.model.id}`,
						);
					}

					if (task.systemPrompt) {
						tmpDir = await mkdtemp(join(tmpdir(), "pi-subagent-"));
						const promptFile = join(tmpDir, "system-prompt.md");
						await writeFile(promptFile, task.systemPrompt, "utf-8");
						args.push("--append-system-prompt", promptFile);
					}

					args.push(task.prompt);

					const invocation = getPiInvocation();
					const proc = childSpawn(
						invocation.command,
						[...invocation.args, ...args],
						{
							cwd: task.cwd,
						},
					);

					killChild = () => {
						clearTimeout(timeoutId);
						killWithEscalation(proc);
					};

					let buffer = "";
					let stderrText = "";
					let bytes = 0;
					const stdoutDecoder = new StringDecoder("utf8");
					const stderrDecoder = new StringDecoder("utf8");

					const handleLine = (line: string): void => {
						processLine(line, {
							onText: (text, kind) =>
								push.push({ type: "text", text, kind }),
							onThinking: (text, kind) =>
								push.push({ type: "thinking", text, kind }),
							onAssistantMessage: (info) =>
								emitAssistantMessage(
									info,
									(event) => push.push(event),
									usage,
								),
						});
					};

					// The byte cap bounds all child output, stdout and stderr
					// alike, so a noisy child cannot exhaust the parent.
					const chargeBytes = (data: Buffer): boolean => {
						bytes += data.length;
						if (overflow) return false;
						if (bytes > maxOutputBytes) {
							overflow = true;
							push.push({
								type: "error",
								message: `subagent output exceeded the ${maxOutputBytes}-byte cap`,
							});
							killWithEscalation(proc);
							return false;
						}
						return true;
					};

					proc.stdout.on("data", (data: Buffer) => {
						if (!chargeBytes(data)) return;
						buffer += stdoutDecoder.write(data);
						const lines = buffer.split("\n");
						buffer = lines.pop() ?? "";
						for (const line of lines) {
							handleLine(line);
						}
					});

					proc.stderr.on("data", (data: Buffer) => {
						if (!chargeBytes(data)) return;
						stderrText += stderrDecoder.write(data);
					});

					proc.on("close", (code) => {
						buffer += stdoutDecoder.end();
						stderrText += stderrDecoder.end();
						if (buffer.trim()) {
							handleLine(buffer);
						}
						finish({
							code: timeoutFired ? -1 : (code ?? 0),
							timedOut: timeoutFired,
							aborted: wasAborted,
							overflow,
							stderr: stderrText,
							spawnError: spawnErrorMessage,
						});
					});

					proc.on("error", (err) => {
						spawnErrorMessage = err.message;
						finish({
							code: 1,
							timedOut: false,
							aborted: wasAborted,
							overflow,
							stderr: stderrText,
							spawnError: err.message,
						});
					});

					if (task.signal) {
						const killProc = () => {
							wasAborted = true;
							killChild?.();
						};
						if (task.signal.aborted) {
							killProc();
						} else {
							task.signal.addEventListener("abort", killProc, {
								once: true,
							});
							removeAbortListener = () =>
								task.signal?.removeEventListener(
									"abort",
									killProc,
								);
						}
					}

					// An abort or timeout arrived before the child existed; kill
					// it now that it does.
					if (abortIntent || timeoutFired) {
						killWithEscalation(proc);
					}
				} catch (err) {
					finish({
						code: 1,
						timedOut: false,
						aborted: wasAborted,
						overflow,
						stderr: "",
						spawnError:
							err instanceof Error ? err.message : String(err),
					});
				}
			})();

			return session;
		},
	};
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function hasAssistantMessageEvent(event: Record<string, unknown>): boolean {
	return (
		event.assistantMessageEvent !== undefined &&
		isObject(event.assistantMessageEvent) &&
		typeof (event.assistantMessageEvent as Record<string, unknown>).type ===
			"string"
	);
}

function defaultSpawn(
	command: string,
	args: string[],
	opts: { cwd: string },
): ProcessBackendSpawn {
	return nodeSpawn(command, args, {
		cwd: opts.cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function getPiInvocation(): { command: string; args: string[] } {
	// Under vitest, process.argv[1] is the test runner's entry, not pi.
	// Spawn the pi binary from PATH so LLM-backed tests exercise the real
	// subagent.
	if (process.env.VITEST) {
		return { command: "pi", args: [] };
	}

	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");

	if (currentScript && !isBunVirtual && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args: [] };
	}

	return { command: "pi", args: [] };
}
