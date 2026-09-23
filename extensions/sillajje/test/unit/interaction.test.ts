/**
 * Tests for `projectInteraction` — the session-log projection seam.
 *
 * The projection turns a session branch and a cursor into the Interaction's
 * derived data and entry range, or undefined when the slice is incomplete.
 */

import type { Message } from "@earendil-works/pi-ai";
import type {
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	lastStampMarkerId,
	projectInteraction,
} from "../../src/interaction.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function userEntry(id: string, text: string, ts = 1000): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
		message: { role: "user", content: text, timestamp: ts } as Message,
	};
}

function assistantEntry(
	id: string,
	text: string,
	opts?: { stopReason?: string; toolCalls?: number },
	ts = 2000,
): SessionMessageEntry {
	const content: Array<{
		type: string;
		text?: string;
		name?: string;
		id?: string;
	}> = [];
	for (let i = 0; i < (opts?.toolCalls ?? 0); i++) {
		content.push({ type: "toolCall", id: `tc-${i}`, name: "read" });
	}
	content.push({ type: "text", text });
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			stopReason: opts?.stopReason ?? "stop",
			timestamp: ts,
		} as unknown as Message,
	};
}

function markerEntry(id: string): SessionEntry {
	return {
		type: "custom",
		customType: "sillajje/stamp",
		data: {},
		id,
		parentId: null,
		timestamp: new Date(3000).toISOString(),
	} as SessionEntry;
}

function compactionEntry(id: string): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: new Date(3000).toISOString(),
		summary: "summary",
		firstKeptEntryId: "x",
		tokensBefore: 1,
	} as SessionEntry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lastStampMarkerId", () => {
	it("returns null when the branch has no Stamp marker", () => {
		const branch = [userEntry("u1", "Hi"), assistantEntry("a1", "Yo")];

		expect(lastStampMarkerId(branch)).toBeNull();
	});

	it("returns the last Stamp marker id on the branch", () => {
		const branch = [
			markerEntry("m1"),
			userEntry("u1", "Hi"),
			assistantEntry("a1", "Yo"),
			markerEntry("m2"),
			userEntry("u2", "Again"),
		];

		expect(lastStampMarkerId(branch)).toBe("m2");
	});
});

describe("projectInteraction", () => {
	it("derives the Interaction from the whole branch when the cursor is null", () => {
		const branch = [userEntry("u1", "Hello"), assistantEntry("a1", "Hi")];

		const result = projectInteraction(branch, null);

		expect(result?.prompt).toBe("Hello");
		expect(result?.response).toBe("Hi");
		expect(result?.range?.first).toBe("u1");
		expect(result?.range?.last).toBe("a1");
	});

	it("derives only the slice after the cursor", () => {
		const branch = [
			userEntry("u1", "Old"),
			assistantEntry("a1", "Old reply"),
			markerEntry("m1"),
			userEntry("u2", "New"),
			assistantEntry("a2", "New reply"),
		];

		const result = projectInteraction(branch, "m1");

		expect(result?.prompt).toBe("New");
		expect(result?.response).toBe("New reply");
		expect(result?.range?.first).toBe("u2");
		expect(result?.range?.last).toBe("a2");
	});

	it("folds a steering or follow-up prompt into one Interaction", () => {
		const branch = [
			userEntry("u1", "First"),
			assistantEntry("a1", "First reply"),
			userEntry("u2", "Actually, use TypeScript"),
			assistantEntry("a2", "Final reply"),
		];

		const result = projectInteraction(branch, null);

		expect(result?.prompt).toBe("First\n\nActually, use TypeScript");
		expect(result?.response).toBe("Final reply");
	});

	it("uses the final assistant response after an error segment", () => {
		const branch = [
			userEntry("u1", "Task"),
			assistantEntry("a1", "", { stopReason: "error" }),
			assistantEntry("a2", "Done"),
		];

		const result = projectInteraction(branch, null);

		expect(result?.response).toBe("Done");
	});

	it("ignores non-message entries inside the slice", () => {
		const branch = [
			userEntry("u1", "Task"),
			compactionEntry("c1"),
			assistantEntry("a1", "Done"),
		];

		const result = projectInteraction(branch, null);

		expect(result?.prompt).toBe("Task");
		expect(result?.response).toBe("Done");
	});

	it("treats the whole branch as new when the cursor is not on it", () => {
		const branch = [userEntry("u1", "Task"), assistantEntry("a1", "Done")];

		const result = projectInteraction(branch, "missing");

		expect(result?.prompt).toBe("Task");
	});

	it("returns undefined when the slice has no assistant message", () => {
		const branch = [userEntry("u1", "Task")];

		expect(projectInteraction(branch, null)).toBeUndefined();
	});

	it("returns undefined when the slice has no user message", () => {
		const branch = [assistantEntry("a1", "Done")];

		expect(projectInteraction(branch, null)).toBeUndefined();
	});
});
