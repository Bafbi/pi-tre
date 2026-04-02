import { describe, expect, it } from "vitest";

import { DEFAULT_MTIME_TOLERANCE_MS, requiresReadBeforeMutation } from "../../src/guard";

describe("requiresReadBeforeMutation", () => {
	it("returns true when no read record exists", () => {
		const blocked = requiresReadBeforeMutation({
			currentMtimeMs: 120,
			lastReadMtimeMs: undefined,
			lastAgentEditMtimeMs: undefined,
		});

		expect(blocked).toBe(true);
	});

	it("returns false when current mtime is within tolerance of last read", () => {
		const blocked = requiresReadBeforeMutation({
			currentMtimeMs: 100 + DEFAULT_MTIME_TOLERANCE_MS,
			lastReadMtimeMs: 100,
			lastAgentEditMtimeMs: undefined,
		});

		expect(blocked).toBe(false);
	});

	it("returns true when file changed since last read", () => {
		const blocked = requiresReadBeforeMutation({
			currentMtimeMs: 150,
			lastReadMtimeMs: 100,
			lastAgentEditMtimeMs: 100,
		});

		expect(blocked).toBe(true);
	});

	it("returns false when file was freshly re-read", () => {
		const blocked = requiresReadBeforeMutation({
			currentMtimeMs: 150,
			lastReadMtimeMs: 150,
			lastAgentEditMtimeMs: 100,
		});

		expect(blocked).toBe(false);
	});

	it("ignores lastAgentEdit when read is stale", () => {
		const blocked = requiresReadBeforeMutation({
			currentMtimeMs: 200,
			lastReadMtimeMs: 100,
			lastAgentEditMtimeMs: 200,
		});

		expect(blocked).toBe(true);
	});
});
