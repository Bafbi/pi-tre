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

	it("clearWorkspacePath unsets the workspace path", () => {
		const s = new SessionState();
		s.setDetection(true, "/repo");
		s.setWorkspacePath("/tmp/ws/repo/sess-001");
		s.clearWorkspacePath();
		expect(s.getWorkspacePath()).toBeUndefined();
	});

	it("archive transition: setArchived + clearWorkspacePath keeps sessionId and repoRoot", () => {
		const s = new SessionState();
		s.setDetection(true, "/repo");
		s.setSessionId("sess-001");
		s.setWorkspacePath("/tmp/ws/repo/sess-001");

		s.setArchived();
		s.clearWorkspacePath();

		expect(s.isArchived()).toBe(true);
		expect(s.isActive()).toBe(false);
		expect(s.getWorkspacePath()).toBeUndefined();
		expect(s.getSessionId()).toBe("sess-001");
		expect(s.getRepoRoot()).toBe("/repo");
	});

	it("unarchive transition: setActive + setWorkspacePath restores workspace", () => {
		const s = new SessionState();
		s.setDetection(true, "/repo");
		s.setSessionId("sess-001");
		s.setArchived();
		s.clearWorkspacePath();

		expect(s.isArchived()).toBe(true);

		s.setActive();
		s.setWorkspacePath("/tmp/ws/repo/sess-001");

		expect(s.isActive()).toBe(true);
		expect(s.isArchived()).toBe(false);
		expect(s.getWorkspacePath()).toBe("/tmp/ws/repo/sess-001");
	});

	it("markStale marks the session stale and reset clears it", () => {
		const s = new SessionState();
		s.setDetection(true, "/repo");
		expect(s.isStale()).toBe(false);

		s.markStale();
		expect(s.isStale()).toBe(true);

		s.reset();
		expect(s.isStale()).toBe(false);
	});

	it("getSessionKey falls back to sessionId and honors setSessionKey", () => {
		const s = new SessionState();
		s.setSessionId("abc123");
		expect(s.getSessionKey()).toBe("abc123");

		// Collision guard: effective key gets a suffix.
		s.setSessionKey("abc123-2");
		expect(s.getSessionKey()).toBe("abc123-2");

		s.reset();
		expect(s.getSessionKey()).toBeUndefined();
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

	it("recordAgentMessages stores messages", () => {
		const s = new SessionState();
		s.startInteraction(undefined);
		const msgs = [
			{ role: "user", content: "Hello", timestamp: 1000 },
			{
				role: "assistant",
				content: [{ type: "text", text: "Hi" }],
				timestamp: 2000,
			},
		] as any[];
		s.recordAgentMessages(msgs);

		const result = s.getInteractionMessages();
		expect(result).toBeDefined();
		expect(result).toHaveLength(2);
	});

	it("recordAgentMessages accumulates across calls", () => {
		const s = new SessionState();
		s.startInteraction(undefined);
		s.recordAgentMessages([
			{ role: "user", content: "A", timestamp: 1000 },
		] as any[]);
		s.recordAgentMessages([
			{
				role: "assistant",
				content: [{ type: "text", text: "B" }],
				timestamp: 2000,
			},
		] as any[]);

		const result = s.getInteractionMessages();
		expect(result).toHaveLength(2);
	});

	it("getInteractionMessages returns undefined with no new interaction", () => {
		const s = new SessionState();
		s.recordAgentMessages([
			{ role: "user", content: "test", timestamp: 1000 },
		] as any[]);
		expect(s.getInteractionMessages()).toBeUndefined();
	});

	it("getInteractionMessages returns undefined with no messages", () => {
		const s = new SessionState();
		s.startInteraction(undefined);
		expect(s.getInteractionMessages()).toBeUndefined();
	});

	it("recordAgentEndError and lastAgentRunWasError track error state", () => {
		const s = new SessionState();
		expect(s.lastAgentRunWasError()).toBe(false);
		s.recordAgentEndError();
		expect(s.lastAgentRunWasError()).toBe(true);
		s.clearPendingFinalize();
		expect(s.lastAgentRunWasError()).toBe(false);
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
		s.resetInteraction();
		// After reset, enableInteractionIfNotSteering should default to
		// treating undefined as non-steer (new interaction)
		s.enableInteractionIfNotSteering();
		expect(s.hasNewInteraction()).toBe(true);
	});

	it("resetInteraction clears all interaction state", () => {
		const s = new SessionState();
		s.startInteraction(undefined);
		s.recordAgentMessages([
			{ role: "user", content: "test", timestamp: 1000 },
		] as any[]);
		s.recordAgentEndError();

		s.resetInteraction();

		expect(s.hasNewInteraction()).toBe(false);
		expect(s.getInteractionMessages()).toBeUndefined();
		expect(s.hasPendingFinalize()).toBe(false);
		expect(s.lastAgentRunWasError()).toBe(false);
	});

	it("reset clears interaction tracking", () => {
		const s = new SessionState();
		s.startInteraction(undefined);
		s.recordAgentMessages([
			{ role: "user", content: "test", timestamp: 1000 },
		] as any[]);

		s.reset();

		expect(s.hasNewInteraction()).toBe(false);
		expect(s.getInteractionMessages()).toBeUndefined();
	});

	it("pending finalize: mark, clear, and reset semantics", () => {
		const s = new SessionState();

		// Default: not pending.
		expect(s.hasPendingFinalize()).toBe(false);

		// Error-terminal agent_end marks the interaction pending.
		s.markPendingFinalize();
		expect(s.hasPendingFinalize()).toBe(true);

		// A retry continuation (agent_start) clears it.
		s.clearPendingFinalize();
		expect(s.hasPendingFinalize()).toBe(false);

		// resetInteraction (called after a stamp) clears it too.
		s.markPendingFinalize();
		s.resetInteraction();
		expect(s.hasPendingFinalize()).toBe(false);
	});
});
