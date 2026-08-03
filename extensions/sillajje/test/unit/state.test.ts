import { describe, expect, it, vi } from "vitest";

import { SessionState } from "../../src/state";

/**
 * Run a test body with deterministic fake timers, restoring real timers
 * afterwards. `SessionState` reads `Date.now()`, which fake timers intercept,
 * so elapsed-time assertions are exact instead of tolerance-based.
 */
function withFakeTimers(fn: () => void): void {
	vi.useFakeTimers();
	try {
		fn();
	} finally {
		vi.useRealTimers();
	}
}

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

	it("recordPrompt stores the prompt text", () => {
		const s = new SessionState();
		s.recordPrompt("Fix the login bug");
		expect(s.getInteractionPrompt()).toBe("Fix the login bug");
	});

	it("markAgentStart records a timestamp (running segment)", () => {
		withFakeTimers(() => {
			const s = new SessionState();
			s.markAgentStart();
			vi.advanceTimersByTime(10);
			expect(s.getInteractionElapsedMs()).toBe(10);
		});
	});

	it("markAgentEnd adds one segment to cumulative", () => {
		withFakeTimers(() => {
			const s = new SessionState();
			s.markAgentStart();
			vi.advanceTimersByTime(15);
			expect(s.getInteractionElapsedMs()).toBe(15);

			// Ending the segment freezes the elapsed value.
			s.markAgentEnd();
			expect(s.getInteractionElapsedMs()).toBe(15);
		});
	});

	it("markAgentEnd accumulates multiple segments", () => {
		withFakeTimers(() => {
			const s = new SessionState();

			s.markAgentStart();
			vi.advanceTimersByTime(10);
			s.markAgentEnd();
			expect(s.getInteractionElapsedMs()).toBe(10);

			s.markAgentStart();
			vi.advanceTimersByTime(25);
			s.markAgentEnd();
			expect(s.getInteractionElapsedMs()).toBe(35);

			// A running third segment is added on top of the cumulative total.
			s.markAgentStart();
			vi.advanceTimersByTime(5);
			expect(s.getInteractionElapsedMs()).toBe(40);
		});
	});

	it("getInteractionElapsedMs returns cumulative when no running segment", () => {
		withFakeTimers(() => {
			const s = new SessionState();
			s.markAgentStart();
			vi.advanceTimersByTime(20);
			s.markAgentEnd();
			expect(s.getInteractionElapsedMs()).toBe(20);

			// No running segment — advancing time does not change the value.
			const frozen = s.getInteractionElapsedMs();
			vi.advanceTimersByTime(50);
			expect(s.getInteractionElapsedMs()).toBe(frozen);
		});
	});

	it("resetInteraction clears cumulative elapsed", () => {
		withFakeTimers(() => {
			const s = new SessionState();
			s.markAgentStart();
			vi.advanceTimersByTime(10);
			s.markAgentEnd();
			expect(s.getInteractionElapsedMs()).toBe(10);

			s.resetInteraction();
			expect(s.getInteractionElapsedMs()).toBe(0);
		});
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
