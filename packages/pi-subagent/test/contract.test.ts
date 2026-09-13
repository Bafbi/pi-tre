import { describe, expect, it } from "vitest";

import { createStubBackend, runSubagent } from "../src/index.js";

/** Collect every event from the session until the event stream closes. */
async function collectEvents(
	session: ReturnType<typeof runSubagent>,
): Promise<unknown[]> {
	const events: unknown[] = [];
	for await (const event of session.events) {
		events.push(event);
	}
	return events;
}

describe("runSubagent contract", () => {
	it("streams a complete fake turn: text, usage, stop reason, then closes", async () => {
		const session = runSubagent(
			{ prompt: "answer this", cwd: "/tmp" },
			createStubBackend(),
		);

		const events = await collectEvents(session);

		expect(events).toContainEqual({
			type: "text",
			text: "stub answer",
			kind: "delta",
		});
		expect(events).toContainEqual({
			type: "stopReason",
			stopReason: "stop",
		});
		expect(
			events.some(
				(e) =>
					typeof e === "object" &&
					e !== null &&
					"type" in e &&
					e.type === "usage",
			),
		).toBe(true);

		// The turn ends with the exit event, per the contract.
		expect(events[events.length - 1]).toMatchObject({
			type: "exit",
			code: 0,
			timedOut: false,
			aborted: false,
			overflow: false,
		});

		// The stream is exhausted: a second read yields nothing.
		const again = await collectEvents(session);
		expect(again).toEqual([]);
	});

	it("reports usage via the usage event and the usage() promise", async () => {
		const session = runSubagent(
			{ prompt: "count me", cwd: "/tmp" },
			createStubBackend({
				usage: { input: 10, output: 5, totalTokens: 15 },
			}),
		);

		const usageEvent = (await collectEvents(session)).find(
			(e) =>
				typeof e === "object" &&
				e !== null &&
				"type" in e &&
				e.type === "usage",
		) as { type: "usage"; usage: Record<string, number> };

		expect(usageEvent.usage).toMatchObject({
			input: 10,
			output: 5,
			totalTokens: 15,
		});
		await expect(session.usage()).resolves.toMatchObject({
			input: 10,
			output: 5,
			totalTokens: 15,
		});
	});

	it("fails on demand when the prompt starts with FAIL:", async () => {
		const session = runSubagent(
			{ prompt: "FAIL: provider overloaded", cwd: "/tmp" },
			createStubBackend(),
		);

		const events = await collectEvents(session);

		expect(events).toContainEqual({
			type: "error",
			message: "provider overloaded",
		});
		expect(events[events.length - 1]).toMatchObject({
			type: "exit",
			code: 1,
		});

		// A failed turn reports zeroed usage.
		await expect(session.usage()).resolves.toEqual({
			turns: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			totalTokens: 0,
		});
	});
});
