/**
 * Tests for `lastSessionBase` — the Base marker the `/sillajje:new` command
 * writes into the new session's log for `session_start` to read back.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { lastSessionBase } from "../../src/session-base.js";

function baseEntry(id: string, data: unknown, ts = 1000): SessionEntry {
	return {
		type: "custom",
		customType: "sillajje/base",
		data,
		id,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
	} as SessionEntry;
}

function otherEntry(id: string): SessionEntry {
	return {
		type: "custom",
		customType: "sillajje/stamp",
		data: {},
		id,
		parentId: null,
		timestamp: new Date(ts()).toISOString(),
	} as SessionEntry;
}

let counter = 0;
function ts(): number {
	return 1000 + counter++;
}

describe("lastSessionBase", () => {
	it("returns undefined when the branch has no Base marker", () => {
		expect(lastSessionBase([otherEntry("m1")])).toBeUndefined();
	});

	it("returns the newest Base marker on the branch", () => {
		const branch = [
			baseEntry("b1", { base: "old", label: "old" }),
			otherEntry("m1"),
			baseEntry("b2", { base: "new", label: "@" }),
		];

		expect(lastSessionBase(branch)).toEqual({ base: "new", label: "@" });
	});

	it("falls back to the base as the label when none is stored", () => {
		const branch = [baseEntry("b1", { base: "abc123" })];

		expect(lastSessionBase(branch)).toEqual({
			base: "abc123",
			label: "abc123",
		});
	});

	it("ignores a Base marker whose data is malformed", () => {
		const branch = [
			baseEntry("b1", { base: "good", label: "good" }),
			baseEntry("b2", { base: 42 }),
			baseEntry("b3", null),
		];

		expect(lastSessionBase(branch)).toEqual({
			base: "good",
			label: "good",
		});
	});
});
