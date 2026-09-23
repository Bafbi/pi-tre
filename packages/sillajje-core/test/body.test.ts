/**
 * The body seam: a commit description is a subject plus an ordered list of
 * named sections.
 */

import { describe, expect, it } from "vitest";
import { assembleDescription } from "../src/index.js";

describe("assembleDescription", () => {
	it("renders labelled sections in order", () => {
		const body = assembleDescription("feat: add login", [
			{ label: "Trace", body: "Did the thing." },
			{ label: "Prompt", body: "Add login." },
		]);
		expect(body).toBe(
			"feat: add login\n\nTrace:\nDid the thing.\n\nPrompt:\nAdd login.",
		);
	});

	it("omits empty sections", () => {
		const body = assembleDescription("feat: add login", [
			{ label: "Trace", body: "" },
			{ label: "Prompt", body: "Add login." },
			{ label: "Response", body: "" },
		]);
		expect(body).toBe("feat: add login\n\nPrompt:\nAdd login.");
	});

	it("renders an inline section on the label line", () => {
		const body = assembleDescription("chore: tidy", [
			{ label: "Meta", body: "tools: read\n  model: x", inline: true },
		]);
		expect(body).toBe("chore: tidy\n\nMeta: tools: read\n  model: x");
	});

	it("assembles a fold's summary and source reference", () => {
		const body = assembleDescription("feat: publish feature", [
			{ label: "Summary", body: "One clean change." },
			{ label: "Ref", body: "abc123..def456", inline: true },
		]);
		expect(body).toBe(
			"feat: publish feature\n\nSummary:\nOne clean change.\n\nRef: abc123..def456",
		);
	});

	it("returns just the subject when every section is empty", () => {
		const body = assembleDescription("feat: add login", [
			{ label: "Trace", body: "" },
			{ label: "Prompt", body: "" },
		]);
		expect(body).toBe("feat: add login");
	});
});
