import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
	type ExplorerProcess,
	runExplorer,
	type SpawnFunction,
} from "../../src/explorer.js";
import type { ParsedRepo } from "../../src/types.js";

const REPO: ParsedRepo = {
	raw: "owner/repo",
	host: "github",
	cloneUrl: "https://github.com/owner/repo.git",
	branch: null,
	displayName: "owner/repo",
	dirName: "repo",
};

/**
 * Fake child process. `responsive` controls whether SIGTERM ends the
 * process; a SIGTERM-ignoring child only dies on SIGKILL.
 */
class FakeProc extends EventEmitter implements ExplorerProcess {
	killed = false;
	signals: string[] = [];
	exitCode: number | null = 0;

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
			this.exitCode = this.exitCodeOnClose;
			queueMicrotask(() => this.emit("close", this.exitCode));
		}
		return true;
	}
}

function makeSpawn(proc: FakeProc, onSpawn?: () => void): SpawnFunction {
	return () => {
		onSpawn?.();
		return proc;
	};
}

/** Resolve once runExplorer has spawned the (fake) child process. */
function waitForSpawn(): { promise: Promise<void>; onSpawn: () => void } {
	let resolve_: () => void = () => {};
	const promise = new Promise<void>((r) => {
		resolve_ = r;
	});
	return { promise, onSpawn: () => resolve_() };
}

function baseOptions(overrides?: Partial<Parameters<typeof runExplorer>[0]>) {
	return {
		workspace: "/tmp/ws",
		repos: [REPO],
		query: "test query",
		signal: undefined,
		...overrides,
	};
}

describe("runExplorer kill and abort handling", () => {
	it("escalates to SIGKILL after the grace period when the child ignores SIGTERM", async () => {
		const proc = new FakeProc(false);
		const abort = new AbortController();

		const promise = runExplorer(baseOptions({ signal: abort.signal }), {
			spawn: makeSpawn(proc),
			killGraceMs: 20,
		});
		abort.abort();
		const result = await promise;

		// SIGTERM first, then the SIGKILL escalation the old code never sent.
		expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);

		// The child never produced output, so the abort is an error.
		expect(result.answer).toBe("");
		expect(result.error).toContain("aborted");
	}, 5_000);

	it("keeps the partial answer and appends a truncation notice on abort", async () => {
		const proc = new FakeProc();
		const abort = new AbortController();
		const spawned = waitForSpawn();

		const promise = runExplorer(baseOptions({ signal: abort.signal }), {
			spawn: makeSpawn(proc, spawned.onSpawn),
			killGraceMs: 20,
		});
		await spawned.promise;

		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					type: "message_update",
					assistantMessageEvent: {
						type: "text_delta",
						delta: "partial ",
					},
				})}\n`,
			),
		);
		abort.abort();
		const result = await promise;

		expect(result.error).toBeUndefined();
		expect(result.answer).toContain("partial");
		expect(result.answer).toContain(
			"[Exploration aborted before completion.]",
		);
	}, 5_000);

	it("surfaces the spawn error message as the exploration error", async () => {
		const proc = new FakeProc();
		const spawn: SpawnFunction = () => {
			queueMicrotask(() =>
				proc.emit("error", new Error("spawn pi ENOENT")),
			);
			return proc;
		};

		const result = await runExplorer(baseOptions(), { spawn });

		expect(result.answer).toBe("");
		expect(result.error).toBe("Exploration failed: spawn pi ENOENT");
	}, 5_000);

	it("removes the abort listener after normal completion", async () => {
		const proc = new FakeProc();
		const abort = new AbortController();
		const spawned = waitForSpawn();

		const promise = runExplorer(baseOptions({ signal: abort.signal }), {
			spawn: makeSpawn(proc, spawned.onSpawn),
			killGraceMs: 20,
		});
		await spawned.promise;
		proc.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
					},
				})}\n`,
			),
		);
		proc.emit("close", 0);
		const result = await promise;

		// A later abort must not reach the already-exited process.
		abort.abort();
		expect(proc.signals).toHaveLength(0);
		expect(result.answer).toBe("done");
	}, 5_000);

	it("accumulates usage across assistant message_end events", async () => {
		const proc = new FakeProc();
		const spawned = waitForSpawn();
		const lines = [
			{
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
			},
			{
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
			},
		];

		const promise = runExplorer(baseOptions(), {
			spawn: makeSpawn(proc, spawned.onSpawn),
			killGraceMs: 20,
		});
		await spawned.promise;
		proc.stdout.emit(
			"data",
			Buffer.from(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`),
		);
		proc.emit("close", 0);
		const result = await promise;

		expect(result.answer).toBe("final answer");
		expect(result.usage).toEqual({
			turns: 2,
			input: 150,
			output: 30,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.003,
			totalTokens: 180,
		});
	}, 5_000);

	it("reports an LLM error mid-exploration instead of a truncated answer", async () => {
		const proc = new FakeProc();
		const spawned = waitForSpawn();
		const lines = [
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "partial ",
				},
			},
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "partial text" }],
					stopReason: "error",
					errorMessage: "provider overloaded",
				},
			},
		];

		const promise = runExplorer(baseOptions(), {
			spawn: makeSpawn(proc, spawned.onSpawn),
			killGraceMs: 20,
		});
		await spawned.promise;
		proc.stdout.emit(
			"data",
			Buffer.from(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`),
		);
		proc.emit("close", 1);
		const result = await promise;

		expect(result.answer).toBe("");
		expect(result.error).toBe("Subagent LLM error: provider overloaded");
	}, 5_000);
});
