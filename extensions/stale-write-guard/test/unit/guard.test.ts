import { describe, expect, it } from "vitest";

import { requiresFullReadBeforeWrite } from "../../src/guard.js";

describe("requiresFullReadBeforeWrite", () => {
	it("returns true when no full read record exists", () => {
		expect(requiresFullReadBeforeWrite(120, undefined)).toBe(true);
	});

	it("returns false when current mtime is within tolerance of the full read", () => {
		expect(requiresFullReadBeforeWrite(102, 100)).toBe(false);
	});

	it("returns true when file changed since the full read", () => {
		expect(requiresFullReadBeforeWrite(150, 100)).toBe(true);
	});

	it("returns false when file was freshly fully read", () => {
		expect(requiresFullReadBeforeWrite(150, 150)).toBe(false);
	});
});
