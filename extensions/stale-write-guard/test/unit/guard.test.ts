import { describe, expect, it } from "vitest";

import { requiresReadBeforeMutation } from "../../src/guard";

describe("requiresReadBeforeMutation", () => {
	it("returns true when no read record exists", () => {
		expect(requiresReadBeforeMutation(120, undefined)).toBe(true);
	});

	it("returns false when current mtime is within tolerance of last read", () => {
		expect(requiresReadBeforeMutation(102, 100)).toBe(false);
	});

	it("returns true when file changed since last read", () => {
		expect(requiresReadBeforeMutation(150, 100)).toBe(true);
	});

	it("returns false when file was freshly re-read", () => {
		expect(requiresReadBeforeMutation(150, 150)).toBe(false);
	});
});
