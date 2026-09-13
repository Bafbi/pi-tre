import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";

import {
	createProcessBackend,
	createSafeAccumulator,
	type ProcessBackendSpawn,
	type ProcessSpawnFn,
	zeroUsage,
} from "../src/index.js";

const tmpDirs: string[] = [];

afterAll(async () => {
	for (const dir of tmpDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * Fake child process. `responsive` controls whether SIGTERM ends the
 * process; a SIGTERM-ignoring child only dies on SIGKILL.
 */
class FakeProc extends EventEmitter implements ProcessBackendSpawn {
	killed = false;
	signals: string[] = [];
	spawnedArgs: string[] = [];

	override stdout = new EventEmitter();
	override stderr = new EventEmitter();

	constructor(
		private readonly responsive = true,
		private readonly exitCodeOnClose: number | null = 0,
	) {
		super();
	}

	override kill(signal?: NodeJS.Signals): boolean {
		const name = signal ?? "SIGTERM";
		this.signals.push(name);
		this.killed = true;
		if (name === "SIGKILL" || this.responsive) {
			queueMicrotask(() => this.emit("close", this.exitCodeOnClose));
		}
		return true;
	}
}

function makeSpawn(
	proc: FakeProc,
	onSpawn?: (proc: FakeProc) => void,
): ProcessSpawnFn {
	return (_command, args) => {
		proc.spawnedArgs = args;
		onSpawn?.(proc);
		return proc;
	};
}

/** Resolve once the backend has spawned the (fake) child process. */
function waitForSpawn(): {
	promise: Promise<FakeProc>;
	onSpawn: (proc: FakeProc) => void;
} {
	let resolve_: (proc: FakeProc) => void = () => {};
	const promise = new Promise<FakeProc>((r) => {
		resolve_ = r;
	});
	return { promise, onSpawn: (proc) => resolve_(proc) };
}

/** Emit one JSON event line to the fake child's stdout. */
function emitLine(proc: FakeProc, event: unknown): void {
	proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
}

async function collectEvents(
	session: ReturnType<ReturnType<typeof createProcessBackend>["run"]>,
): Promise<unknown[]> {
	const events: unknown[] = [];
	for await (const event of session.events) {
		events.push(event);
	}
	return events;
}

function baseBackend(
	spawn: ProcessSpawnFn,
	options?: Parameters<typeof createProcessBackend>[0],
) {
	return createProcessBackend({ spawn, killGraceMs: 20, ...options });
}

describe("createProcessBackend event parsing", () => {
	it("streams text and thinking deltas, full text, usage, and stop reason", async () => {
		const proc = new FakeProc();
		const spawned = waitForSpawn();

		const session = baseBackend(makeSpawn(proc, spawned.onSpawn)).run({
			prompt: "Task: test",
			cwd: "/tmp",
		});
		const child = await spawned.promise;

		emitLine(child, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Hello " },
		});
		emitLine(child, {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "step 1" },
		});
		emitLine(child, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hello world" }],
				usage: {
					input: 100,
					output: 10,
					totalTokens: 110,
					cost: { total: 0.001 },
				},
				stopReason: "stop",
			},
		});
		child.emit("close", 0);

		const events = await collectEvents(session);

		expect(events).toContainEqual({
			type: "text",
			text: "Hello ",
			kind: "delta",
		});
		expect(events).toContainEqual({
			type: "thinking",
			text: "step 1",
			kind: "delta",
		});
		expect(events).toContainEqual({
			type: "text",
			text: "Hello world",
			kind: "full",
		});
		expect(events).toContainEqual({
			type: "stopReason",
			stopReason: "stop",
		});

		const usageEvent = events.find(
			(e) =>
				typeof e === "object" &&
				e !== null &&
				"type" in e &&
				e.type === "usage",
		) as { type: "usage"; usage: Record<string, number> };
		expect(usageEvent.usage).toEqual({
			turns: 1,
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.001,
			totalTokens: 110,
		});
		await expect(session.usage()).resolves.toEqual({
			turns: 1,
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.001,
			totalTokens: 110,
		});
	});

	it("accumulates usage across assistant message_end events", async () => {
		const proc = new FakeProc();
		const spawned = waitForSpawn();

		const session = baseBackend(makeSpawn(proc, spawned.onSpawn)).run({
			prompt: "Task: test",
			cwd: "/tmp",
		});
		const child = await spawned.promise;

		emitLine(child, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "thinking out loud" }],
				usage: {
					input: 100,
					output: 10,
					totalTokens: 110,
					cost: { total: 0.001 },
				},
				stopReason: "toolUse",
			},
		});
		emitLine(child, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "final answer" }],
				usage: {
					input: 50,
					output: 20,
					totalTokens: 70,
					cost: { total: 0.002 },
				},
				stopReason: "stop",
			},
		});
		child.emit("close", 0);

		await expect(session.usage()).resolves.toEqual({
			turns: 2,
			input: 150,
			output: 30,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.003,
			totalTokens: 180,
		});
	});

	it("reports an LLM error as an error event", async () => {
		const proc = new FakeProc();
		const spawned = waitForSpawn();

		const session = baseBackend(makeSpawn(proc, spawned.onSpawn)).run({
			prompt: "Task: test",
			cwd: "/tmp",
		});
		const child = await spawned.promise;

		emitLine(child, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
				stopReason: "error",
				errorMessage: "provider overloaded",
			},
		});
		child.emit("close", 1);

		const events = await collectEvents(session);
		expect(events).toContainEqual({
			type: "error",
			message: "provider overloaded",
		});
	});

	it("ignores invalid, non-object, and non-assistant lines", async () => {
		const proc = new FakeProc();
		const spawned = waitForSpawn();

		const session = baseBackend(makeSpawn(proc, spawned.onSpawn)).run({
			prompt: "Task: test",
			cwd: "/tmp",
		});
		const child = await spawned.promise;

		child.stdout.emit("data", Buffer.from("not json\n42\n"));
		emitLine(child, {
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "hi" }] },
		});
		emitLine(child, {
			type: "message_end",
			message: { role: "assistant" },
		});
		child.emit("close", 0);

		const events = await collectEvents(session);
		expect(
			events.filter(
				(e) =>
					typeof e === "object" &&
					e !== null &&
					"type" in e &&
					(e.type === "text" || e.type === "usage"),
			),
		).toEqual([]);
	});

	it("joins multiple text parts into one full-message event", async () => {
		const proc = new FakeProc();
		const spawned = waitForSpawn();

		const session = baseBackend(makeSpawn(proc, spawned.onSpawn)).run({
			prompt: "Task: test",
			cwd: "/tmp",
		});
		const child = await spawned.promise;

		emitLine(child, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "foo" },
					{ type: "text", text: "bar" },
				],
			},
		});
		child.emit("close", 0);

		const events = await collectEvents(session);
		const accumulator = createSafeAccumulator();
		for (const event of events) {
			const e = event as {
				type: string;
				text?: string;
				kind?: "delta" | "full";
			};
			if (e.type === "text") accumulator.append(e.text ?? "", e.kind);
		}
		expect(accumulator.get()).toBe("foobar");
	});

	it("ignores malformed content parts instead of throwing", async () => {
		const proc = new FakeProc();
		const spawned = waitForSpawn();

		const session = baseBackend(makeSpawn(proc, spawned.onSpawn)).run({
			prompt: "Task: test",
			cwd: "/tmp",
		});
		const child = await spawned.promise;

		emitLine(child, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [null, { type: "text", text: "ok" }],
			},
		});
		child.emit("close", 0);

		const events = await collectEvents(session);
		expect(events).toContainEqual({
			type: "text",
			text: "ok",
			kind: "full",
		});
	});

	it("decodes a multibyte character split across stdout chunks", async () => {
		const proc = new FakeProc();
		const spawned = waitForSpawn();

		const session = baseBackend(makeSpawn(proc, spawned.onSpawn)).run({
			prompt: "Task: test",
			cwd: "/tmp",
		});
		const child = await spawned.promise;

		const line = Buffer.from(
			`${JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "héllo" }],
				},
			})}\n`,
			"utf8",
		);
		// Split inside the two-byte "é" to exercise the streaming decoder.
		const splitAt = line.indexOf(Buffer.from("é", "utf8")) + 1;
		child.stdout.emit("data", line.subarray(0, splitAt));
		child.stdout.emit("data", line.subarray(splitAt));
		child.emit("close", 0);

		const events = await collectEvents(session);
		expect(events).toContainEqual({
			type: "text",
			text: "héllo",
			kind: "full",
		});
	});

	it("delivers the system prompt through a temp file and removes it after the run", async () => {
		const proc = new FakeProc();
		const spawned = waitForSpawn();

		const session = baseBackend(makeSpawn(proc, spawned.onSpawn)).run({
			prompt: "Task: test",
			cwd: "/tmp",
			systemPrompt: "You are an exploration agent.",
		});
		const child = await spawned.promise;

		const promptFlagIndex = child.spawnedArgs.indexOf(
			"--append-system-prompt",
		);
		expect(promptFlagIndex).toBeGreaterThan(-1);
		const promptPath = child.spawnedArgs[promptFlagIndex + 1];
		expect(promptPath).toBeDefined();
		// The file exists while the child runs and holds the prompt.
		expect(existsSync(promptPath)).toBe(true);
		await expect(readFile(promptPath, "utf-8")).resolves.toBe(
			"You are an exploration agent.",
		);

		child.emit("close", 0);
		await collectEvents(session);

		expect(existsSync(promptPath)).toBe(false);
	});

	it("maps an empty allowlist to --no-tools", async () => {
		const proc = new FakeProc();
		const spawned = waitForSpawn();

		const session = baseBackend(makeSpawn(proc, spawned.onSpawn)).run({
			prompt: "Task: test",
			cwd: "/tmp",
			tools: [],
		});
		const child = await spawned.promise;

		// [] means "no tools", matching the in-process backend's reading.
		expect(child.spawnedArgs).toContain("--no-tools");
		child.emit("close", 0);
		await collectEvents(session);
	});
});

describe("createSafeAccumulator", () => {
	it("appends deltas and keeps a full text that extends the value", () => {
		const acc = createSafeAccumulator();
		acc.append("Hello ");
		acc.append("world");
		acc.append("Hello world", "full");
		expect(acc.get()).toBe("Hello world");
	});

	it("replaces the value when the provider rewrites the final message", () => {
		const acc = createSafeAccumulator();
		acc.append("old draft");
		acc.append("rewritten final", "full");
		expect(acc.get()).toBe("rewritten final");
	});

	it("ignores empty appends", () => {
		const acc = createSafeAccumulator();
		acc.append("");
		expect(acc.get()).toBe("");
	});
});

describe("createProcessBackend kill, abort, and timeout", () => {
	it("escalates to SIGKILL after the grace period when the child ignores SIGTERM on abort", async () => {
		const proc = new FakeProc(false);
		const abort = new AbortController();

		const session = baseBackend(makeSpawn(proc)).run({
			prompt: "Task: test",
			cwd: "/tmp",
			signal: abort.signal,
		});
		abort.abort();

		const events = await collectEvents(session);

		expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
		const exit = events[events.length - 1] as {
			type: string;
			aborted: boolean;
		};
		expect(exit.type).toBe("exit");
		expect(exit.aborted).toBe(true);
	}, 5_000);

	it("keeps streamed output available to the caller after abort", async () => {
		const proc = new FakeProc();
		const abort = new AbortController();
		const spawned = waitForSpawn();

		const session = baseBackend(makeSpawn(proc, spawned.onSpawn)).run({
			prompt: "Task: test",
			cwd: "/tmp",
			signal: abort.signal,
		});
		const child = await spawned.promise;

		const received: unknown[] = [];
		const reading = (async () => {
			for await (const event of session.events) {
				received.push(event);
			}
		})();

		emitLine(child, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "partial " },
		});
		abort.abort();

		await reading;
		expect(received).toContainEqual({
			type: "text",
			text: "partial ",
			kind: "delta",
		});
		const exit = received[received.length - 1] as {
			type: string;
			aborted: boolean;
		};
		expect(exit.type).toBe("exit");
		expect(exit.aborted).toBe(true);
	}, 5_000);

	it("removes the abort listener after normal completion", async () => {
		const proc = new FakeProc();
		const abort = new AbortController();
		const spawned = waitForSpawn();

		const session = baseBackend(makeSpawn(proc, spawned.onSpawn)).run({
			prompt: "Task: test",
			cwd: "/tmp",
			signal: abort.signal,
		});
		const child = await spawned.promise;

		emitLine(child, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
			},
		});
		child.emit("close", 0);
		await collectEvents(session);

		// A later abort must not reach the already-exited process.
		abort.abort();
		expect(proc.signals).toHaveLength(0);
	}, 5_000);

	it("resolves abort() only after the run ends", async () => {
		const proc = new FakeProc(false);
		const spawned = waitForSpawn();

		const session = baseBackend(makeSpawn(proc, spawned.onSpawn), {
			killGraceMs: 1_000,
		}).run({ prompt: "Task: test", cwd: "/tmp" });
		const child = await spawned.promise;
		const reading = collectEvents(session);

		let settled = false;
		const aborted = session.abort().then(() => {
			settled = true;
		});
		// SIGTERM is sent, but the child has not closed yet.
		await new Promise((r) => setTimeout(r, 10));
		expect(settled).toBe(false);

		child.emit("close", 0);
		await aborted;
		expect(settled).toBe(true);
		await reading;
	}, 5_000);

	it("escalates SIGTERM to SIGKILL on timeout and reports timedOut", async () => {
		const proc = new FakeProc(false);
		const spawned = waitForSpawn();

		const session = baseBackend(makeSpawn(proc, spawned.onSpawn), {
			killGraceMs: 10,
		}).run({
			prompt: "Task: test",
			cwd: "/tmp",
			timeoutMs: 30,
		});
		await spawned.promise;

		const events = await collectEvents(session);

		expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
		const exit = events[events.length - 1] as {
			type: string;
			timedOut: boolean;
		};
		expect(exit.type).toBe("exit");
		expect(exit.timedOut).toBe(true);
	}, 5_000);

	it("surfaces spawn errors in the exit event", async () => {
		const proc = new FakeProc();
		const spawn: ProcessSpawnFn = () => {
			queueMicrotask(() =>
				proc.emit("error", new Error("spawn pi ENOENT")),
			);
			return proc;
		};

		const session = baseBackend(spawn).run({
			prompt: "Task: test",
			cwd: "/tmp",
		});
		const events = await collectEvents(session);

		const exit = events[events.length - 1] as {
			type: string;
			spawnError?: string;
			code: number;
		};
		expect(exit.type).toBe("exit");
		expect(exit.spawnError).toBe("spawn pi ENOENT");
		expect(exit.code).toBe(1);
	}, 5_000);

	it("caps stdout at maxOutputBytes and reports overflow", async () => {
		const proc = new FakeProc();
		const spawned = waitForSpawn();

		const session = baseBackend(makeSpawn(proc, spawned.onSpawn), {
			maxOutputBytes: 16,
		}).run({ prompt: "Task: test", cwd: "/tmp" });
		const child = await spawned.promise;

		child.stdout.emit("data", Buffer.from("x".repeat(64)));
		const events = await collectEvents(session);

		// The oversized child is stopped with the usual escalation.
		expect(proc.signals).toContain("SIGTERM");
		const exit = events[events.length - 1] as {
			type: string;
			overflow: boolean;
		};
		expect(exit.type).toBe("exit");
		expect(exit.overflow).toBe(true);
	}, 5_000);

	it("counts stderr toward the output cap", async () => {
		const proc = new FakeProc();
		const spawned = waitForSpawn();

		const session = baseBackend(makeSpawn(proc, spawned.onSpawn), {
			maxOutputBytes: 16,
		}).run({ prompt: "Task: test", cwd: "/tmp" });
		const child = await spawned.promise;

		child.stderr.emit("data", Buffer.from("e".repeat(64)));
		const events = await collectEvents(session);

		expect(proc.signals).toContain("SIGTERM");
		expect(events).toContainEqual({
			type: "error",
			message: expect.stringContaining("exceeded"),
		});
		const exit = events[events.length - 1] as {
			type: string;
			overflow: boolean;
		};
		expect(exit.type).toBe("exit");
		expect(exit.overflow).toBe(true);
	}, 5_000);

	it("resolves usage() to zeroed usage when the child produced no usage", async () => {
		const proc = new FakeProc();
		const spawned = waitForSpawn();

		const session = baseBackend(makeSpawn(proc, spawned.onSpawn)).run({
			prompt: "Task: test",
			cwd: "/tmp",
		});
		const child = await spawned.promise;
		child.emit("close", 1);

		await expect(session.usage()).resolves.toEqual(zeroUsage());
	}, 5_000);
});

describe("createProcessBackend default timeout", () => {
	it("documents the 300 s default by exposing it as a constant", async () => {
		// The default lives in the package so callers can align on it.
		const { DEFAULT_PROCESS_TIMEOUT_MS } = await import(
			"../src/process-backend.js"
		);
		expect(DEFAULT_PROCESS_TIMEOUT_MS).toBe(300_000);
	});
});
