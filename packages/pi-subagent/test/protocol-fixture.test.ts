import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	createProcessBackend,
	createSafeAccumulator,
	type ProcessBackendSpawn,
} from "../src/index.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const fixtureLines = (
	await readFile(join(fixtureDir, "pi-session.jsonl"), "utf-8")
)
	.split("\n")
	.filter((line) => line.trim().length > 0);

const meta = JSON.parse(
	await readFile(join(fixtureDir, "pi-session.meta.json"), "utf-8"),
) as { piVersion: string };

/** Installed pi version, as pnpm wired it for this workspace. */
const installedPiVersion: string = (() => {
	// pi's package.json is not in its exports map, so locate the installed
	// peer directly: walk up from this test file looking for the pnpm/
	// npm-installed copy under node_modules.
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const candidate = join(
			dir,
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			"package.json",
		);
		if (existsSync(candidate)) {
			return (
				JSON.parse(readFileSync(candidate, "utf-8")) as {
					version: string;
				}
			).version;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(
		"could not locate @earendil-works/pi-coding-agent's package.json",
	);
})();

/**
 * Replayed child: streams the fixture lines to stdout when the backend
 * spawns it, then closes cleanly.
 */
class ReplayProc extends EventEmitter implements ProcessBackendSpawn {
	killed = false;
	stdout = new EventEmitter();
	stderr = new EventEmitter();

	kill(): boolean {
		this.killed = true;
		return true;
	}
}

interface AssistantEndUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

/** Sum the usage over the fixture's assistant `message_end` lines. */
function expectedUsage(): AssistantEndUsage {
	const total: AssistantEndUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
	for (const line of fixtureLines) {
		const event = JSON.parse(line) as {
			type?: string;
			message?: {
				role?: string;
				usage?: {
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
					totalTokens?: number;
					cost?: { total?: number };
				};
			};
		};
		if (event.type !== "message_end") continue;
		const message = event.message;
		if (message?.role !== "assistant" || !message.usage) {
			continue;
		}
		total.input += message.usage.input ?? 0;
		total.output += message.usage.output ?? 0;
		total.cacheRead += message.usage.cacheRead ?? 0;
		total.cacheWrite += message.usage.cacheWrite ?? 0;
		total.totalTokens += message.usage.totalTokens ?? 0;
		total.cost += message.usage.cost?.total ?? 0;
	}
	return total;
}

describe("pi protocol fixture (replayed session)", () => {
	it("is pinned to the installed pi version", () => {
		// The fixture records the protocol of the pi version that produced
		// it. On a pi bump this fails so the fixture is regenerated
		// deliberately and the parser is re-proven against the new shapes:
		//
		// 	mise run //packages/pi-subagent:generate-fixture
		expect(meta.piVersion).toBe(installedPiVersion);
	});

	it("replays into typed events with the pinned shapes", async () => {
		const proc = new ReplayProc();
		const backend = createProcessBackend({
			spawn: () => {
				// Stream the recorded lines exactly as the child wrote them.
				queueMicrotask(() => {
					proc.stdout.emit(
						"data",
						Buffer.from(`${fixtureLines.join("\n")}\n`),
					);
					proc.emit("close", 0);
				});
				return proc;
			},
		});

		const session = backend.run({
			prompt: "Task: replay",
			cwd: "/fixture",
		});

		const text = createSafeAccumulator();
		let thinkingDeltas = 0;
		let stopReason: string | undefined;
		let usageEvent: { type: string; usage: unknown } | undefined;
		const events: unknown[] = [];
		for await (const event of session.events) {
			events.push(event);
			if (event.type === "text") text.append(event.text, event.kind);
			if (event.type === "thinking" && event.kind === "delta") {
				thinkingDeltas++;
			}
			if (event.type === "usage") usageEvent = event;
			if (event.type === "stopReason") stopReason = event.stopReason;
		}

		// The pinned assistant message: thinking deltas streamed, then the
		// full text in the message_end content.
		expect(thinkingDeltas).toBeGreaterThan(0);
		expect(text.get()).toBe("hello world");
		expect(stopReason).toBe("stop");

		const usage = expectedUsage();
		expect(usageEvent?.usage).toEqual({
			turns: 1,
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cost: usage.cost,
			totalTokens: usage.totalTokens,
		});
		await expect(session.usage()).resolves.toEqual({
			turns: 1,
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cost: usage.cost,
			totalTokens: usage.totalTokens,
		});

		// Non-assistant lines (session, user messages, turn_end, agent_end)
		// produce no events of their own; the run ends cleanly.
		const exit = events[events.length - 1] as {
			type: string;
			code: number;
			timedOut: boolean;
			aborted: boolean;
			overflow: boolean;
		};
		expect(exit).toEqual({
			type: "exit",
			code: 0,
			timedOut: false,
			aborted: false,
			overflow: false,
			stderr: "",
		});
		expect(
			events.filter((e) => (e as { type: string }).type === "error"),
		).toEqual([]);
	});
});
