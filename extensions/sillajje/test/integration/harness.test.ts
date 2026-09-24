/**
 * Tests for the integration harness's session-log writer.
 *
 * The adapter reads the Interaction transcript from the session log, so the
 * harness must be able to put messages there. This pins that helper's contract.
 */

import { describe, expect, it } from "vitest";

import {
	createRunner,
	getSessionManager,
	makeRunnerCwd,
	recordInteraction,
} from "./_helpers.js";

describe("recordInteraction", () => {
	it("appends a user and an assistant message to the session branch", async () => {
		const cwd = makeRunnerCwd();
		const runner = await createRunner(cwd);

		recordInteraction(runner, "Hello", "Hi there");

		const messages = getSessionManager(runner)
			.getBranch()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);

		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ role: "user", content: "Hello" });
		expect(messages[1]).toMatchObject({ role: "assistant" });
	});
});
