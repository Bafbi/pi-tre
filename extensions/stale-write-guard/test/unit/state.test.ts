import { describe, expect, it } from "vitest";

import { FileTrackingStore } from "../../src/state";

describe("FileTrackingStore", () => {
	it("stores and retrieves read timestamps", () => {
		const store = new FileTrackingStore();
		store.markRead("/tmp/file.txt", 100);

		expect(store.get("/tmp/file.txt")).toEqual({
			lastReadMtimeMs: 100,
		});
	});

	it("markAgentEdit updates both lastAgentEdit and lastRead", () => {
		const store = new FileTrackingStore();
		store.markAgentEdit("/tmp/file.txt", 200);

		expect(store.get("/tmp/file.txt")).toEqual({
			lastAgentEditMtimeMs: 200,
			lastReadMtimeMs: 200,
		});
	});

	it("clear removes all tracked state", () => {
		const store = new FileTrackingStore();
		store.markRead("/tmp/a", 1);
		store.markAgentEdit("/tmp/b", 2);

		expect(store.size()).toBe(2);
		store.clear();
		expect(store.size()).toBe(0);
		expect(store.get("/tmp/a")).toBeUndefined();
	});
});
