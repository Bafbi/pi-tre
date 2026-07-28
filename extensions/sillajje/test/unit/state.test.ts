import { describe, expect, it } from "vitest";

import { SessionState } from "../../src/state";

describe("SessionState", () => {
	it("defaults to inactive with no repo root", () => {
		const s = new SessionState();
		expect(s.isInactive()).toBe(true);
		expect(s.isActive()).toBe(false);
		expect(s.isArchived()).toBe(false);
		expect(s.getLifecycle()).toBe("inactive");
		expect(s.getRepoRoot()).toBeUndefined();
		expect(s.getSessionId()).toBeUndefined();
		expect(s.getWorkspacePath()).toBeUndefined();
		expect(s.isJjAvailable()).toBe(false);
	});

	it("setDetection with jjAvailable=false stays inactive", () => {
		const s = new SessionState();
		s.setDetection(false);
		expect(s.isInactive()).toBe(true);
		expect(s.isJjAvailable()).toBe(false);
		expect(s.getRepoRoot()).toBeUndefined();
	});

	it("setDetection with jjAvailable=true but no repo root stays inactive", () => {
		const s = new SessionState();
		s.setDetection(true);
		expect(s.isInactive()).toBe(true);
		expect(s.isJjAvailable()).toBe(true);
		expect(s.getRepoRoot()).toBeUndefined();
	});

	it("setDetection with jjAvailable and repo root transitions to active", () => {
		const s = new SessionState();
		s.setDetection(true, "/home/user/repo");
		expect(s.isActive()).toBe(true);
		expect(s.isJjAvailable()).toBe(true);
		expect(s.getRepoRoot()).toBe("/home/user/repo");
	});

	it("transitions between lifecycle states explicitly", () => {
		const s = new SessionState();

		s.setDetection(true, "/repo");
		expect(s.isActive()).toBe(true);

		s.setArchived();
		expect(s.isArchived()).toBe(true);
		expect(s.isActive()).toBe(false);

		s.setActive();
		expect(s.isActive()).toBe(true);
		expect(s.isArchived()).toBe(false);

		s.setInactive();
		expect(s.isInactive()).toBe(true);
	});

	it("reset clears everything", () => {
		const s = new SessionState();
		s.setDetection(true, "/repo");
		s.setSessionId("abc123");
		s.setWorkspacePath("/tmp/ws");

		s.reset();

		expect(s.isInactive()).toBe(true);
		expect(s.isJjAvailable()).toBe(false);
		expect(s.getRepoRoot()).toBeUndefined();
		expect(s.getSessionId()).toBeUndefined();
		expect(s.getWorkspacePath()).toBeUndefined();
	});

	it("setSessionId and setWorkspacePath", () => {
		const s = new SessionState();
		s.setDetection(true, "/repo");
		s.setSessionId("sess-001");
		s.setWorkspacePath("/tmp/pi/sillajje/repo/sess-001");

		expect(s.getSessionId()).toBe("sess-001");
		expect(s.getWorkspacePath()).toBe("/tmp/pi/sillajje/repo/sess-001");
	});

	it("hasUserPrompted defaults to false", () => {
		const s = new SessionState();
		expect(s.hasUserPrompted()).toBe(false);
	});

	it("markPrompted sets hasUserPrompted to true", () => {
		const s = new SessionState();
		s.markPrompted();
		expect(s.hasUserPrompted()).toBe(true);
	});

	it("reset clears hasUserPrompted", () => {
		const s = new SessionState();
		s.markPrompted();
		expect(s.hasUserPrompted()).toBe(true);
		s.reset();
		expect(s.hasUserPrompted()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Interaction tracking
// ---------------------------------------------------------------------------

describe("SessionState interaction tracking", () => {
	it("startInteraction with undefined streamingBehavior marks new interaction", () => {
		const s = new SessionState();
		s.startInteraction(undefined);
		expect(s.hasNewInteraction()).toBe(true);
	});

	it("startInteraction with followUp marks new interaction", () => {
		const s = new SessionState();
		s.startInteraction("followUp");
		expect(s.hasNewInteraction()).toBe(true);
	});

	it("startInteraction with steer does NOT mark new interaction", () => {
		const s = new SessionState();
		s.startInteraction("steer");
		expect(s.hasNewInteraction()).toBe(false);
	});

	it("recordPrompt stores the prompt text", () => {
		const s = new SessionState();
		s.recordPrompt("Fix the login bug");
		expect(s.getInteractionPrompt()).toBe("Fix the login bug");
	});

	it("markAgentStart records a timestamp (running segment)", () => {
		const before = Date.now();
		const s = new SessionState();
		s.markAgentStart();
		const after = Date.now();
		const elapsed = s.getInteractionElapsedMs();
		expect(elapsed).toBeGreaterThanOrEqual(0);
		expect(elapsed).toBeLessThanOrEqual(after - before + 50);
	});

	it("markAgentEnd adds one segment to cumulative", () => {
		const s = new SessionState();
		s.markAgentStart();
		const elapsed = s.getInteractionElapsedMs();
		s.markAgentEnd();
		// After end, getter should return at least as much as before end
		const afterEnd = s.getInteractionElapsedMs();
		expect(afterEnd).toBeGreaterThanOrEqual(elapsed - 5); // slight timing tolerance
	});

	it("markAgentEnd accumulates multiple segments", async () => {
		const s = new SessionState();

		s.markAgentStart();
		await new Promise((r) => setTimeout(r, 10));
		s.markAgentEnd();
		const afterSeg1 = s.getInteractionElapsedMs();

		s.markAgentStart();
		await new Promise((r) => setTimeout(r, 10));
		s.markAgentEnd();
		const afterSeg2 = s.getInteractionElapsedMs();

		// Each segment adds to the cumulative total
		expect(afterSeg1).toBeGreaterThanOrEqual(5);
		expect(afterSeg2).toBeGreaterThan(afterSeg1);
	});

	it("getInteractionElapsedMs returns cumulative when no running segment", () => {
		const s = new SessionState();
		s.markAgentStart();
		s.markAgentEnd();
		const frozen = s.getInteractionElapsedMs();
		// After a small delay, the value should not increase because no segment is running
		const later = s.getInteractionElapsedMs();
		expect(later).toBe(frozen);
	});

	it("resetInteraction clears cumulative elapsed", async () => {
		const s = new SessionState();
		s.markAgentStart();
		await new Promise((r) => setTimeout(r, 10));
		s.markAgentEnd();
		expect(s.getInteractionElapsedMs()).toBeGreaterThan(0);

		s.resetInteraction();
		expect(s.getInteractionElapsedMs()).toBe(0);
	});

	it("recordToolCall increments count and tracks unique names", () => {
		const s = new SessionState();
		s.startInteraction(undefined);
		s.recordPrompt("test");
		s.recordToolCall("read");
		s.recordToolCall("write");
		s.recordToolCall("read");

		const data = s.getInteractionData("sess-1");
		expect(data).toBeDefined();
		if (!data) throw new Error("data should be defined");
		expect(data.toolCallCount).toBe(3);
		expect(data.toolNames).toEqual(["read", "write"]);
	});

	it("recordThinkingBlock increments thinking block count", () => {
		const s = new SessionState();
		s.startInteraction(undefined);
		s.recordPrompt("test");
		s.recordThinkingBlock();
		s.recordThinkingBlock();

		const data = s.getInteractionData("sess-1");
		expect(data).toBeDefined();
		if (!data) throw new Error("data should be defined");
		expect(data.thinkingBlocks).toBe(2);
	});

	it("recordAgentResponse stores the response", () => {
		const s = new SessionState();
		s.recordAgentResponse("I fixed the bug.");
		expect(s.getInteractionResponse()).toBe("I fixed the bug.");
	});

	it("getInteractionData returns snapshot with all fields", () => {
		const s = new SessionState();
		s.startInteraction(undefined);
		s.recordPrompt("Add a login page");
		s.markAgentStart();
		s.recordToolCall("write");
		s.recordToolCall("edit");
		s.recordThinkingBlock();
		s.recordAgentResponse("Done.");

		const data = s.getInteractionData("abc");
		expect(data).toBeDefined();
		if (!data) throw new Error("data should be defined");
		expect(data.toolNames).toEqual(["write", "edit"]);
		expect(data.toolCallCount).toBe(2);
		expect(data.thinkingBlocks).toBe(1);
		expect(data.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(data.sessionId).toBe("abc");
	});

	it("getInteractionData returns undefined when no new interaction", () => {
		const s = new SessionState();
		s.recordPrompt("test");
		s.markAgentStart();

		// Without calling startInteraction, hasNewInteraction defaults to false
		expect(s.getInteractionData("id")).toBeUndefined();
	});

	it("getInteractionData returns undefined when prompt is missing", () => {
		const s = new SessionState();
		s.startInteraction(undefined);
		s.markAgentStart();

		expect(s.getInteractionData("id")).toBeUndefined();
	});

	it("enableInteractionIfNotSteering enables new interaction when no steering was recorded", () => {
		const s = new SessionState();
		// Simulate: a fresh prompt — input fires with undefined streamingBehavior
		s.startInteraction(undefined);
		// After stamp, reset is called
		s.resetInteraction();
		expect(s.hasNewInteraction()).toBe(false);
		// Now a queued follow-up comes in via before_agent_start (no preceding input)
		// lastStreamingBehavior is undefined after reset → treated as non-steer
		s.enableInteractionIfNotSteering();
		expect(s.hasNewInteraction()).toBe(true);
	});

	it("enableInteractionIfNotSteering enables after followUp and reset", () => {
		const s = new SessionState();
		// Simulate: input fires with "followUp"
		s.startInteraction("followUp");
		expect(s.hasNewInteraction()).toBe(true);
		// After stamp, reset
		s.resetInteraction();
		expect(s.hasNewInteraction()).toBe(false);
		// Now a queued follow-up comes via before_agent_start without input.
		// lastStreamingBehavior was reset, so it's undefined → non-steer.
		s.enableInteractionIfNotSteering();
		expect(s.hasNewInteraction()).toBe(true);
	});

	it("enableInteractionIfNotSteering does NOT enable after steer input", () => {
		const s = new SessionState();
		// Normal steer flow: input fires with "steer", then before_agent_start fires
		s.startInteraction("steer");
		expect(s.hasNewInteraction()).toBe(false);
		s.enableInteractionIfNotSteering();
		// Should still be false because lastStreamingBehavior is "steer"
		expect(s.hasNewInteraction()).toBe(false);
	});

	it("startInteraction + enableInteractionIfNotSteering without reset: steer stays false", () => {
		const s = new SessionState();
		// Normal steer flow: input fires with steer, then before_agent_start fires
		s.startInteraction("steer");
		expect(s.hasNewInteraction()).toBe(false);
		s.enableInteractionIfNotSteering();
		// Should still be false because lastStreamingBehavior is "steer"
		expect(s.hasNewInteraction()).toBe(false);
	});

	it("lastStreamingBehavior is reset by resetInteraction", () => {
		const s = new SessionState();
		s.startInteraction("followUp");
		s.recordPrompt("test");
		s.resetInteraction();
		// After reset, enableInteractionIfNotSteering should default to
		// treating undefined as non-steer (new interaction)
		s.enableInteractionIfNotSteering();
		expect(s.hasNewInteraction()).toBe(true);
	});

	it("resetInteraction clears all interaction state", () => {
		const s = new SessionState();
		s.startInteraction(undefined);
		s.recordPrompt("test");
		s.markAgentStart();
		s.recordToolCall("read");
		s.recordThinkingBlock();
		s.recordAgentResponse("done");

		s.resetInteraction();

		expect(s.hasNewInteraction()).toBe(false);
		expect(s.getInteractionPrompt()).toBeUndefined();
		expect(s.getInteractionResponse()).toBeUndefined();

		const data = s.getInteractionData("id");
		expect(data).toBeUndefined();
	});

	it("reset clears interaction tracking", () => {
		const s = new SessionState();
		s.startInteraction(undefined);
		s.recordPrompt("test");
		s.recordToolCall("read");

		s.reset();

		expect(s.hasNewInteraction()).toBe(false);
		expect(s.getInteractionPrompt()).toBeUndefined();
	});
});
