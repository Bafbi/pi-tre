import { describe, expect, it } from "vitest";

import { SessionState } from "../../src/state.js";

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

	it("markMissingWorkspace marks the workspace missing and reset clears it", () => {
		const s = new SessionState();
		s.setDetection(true, "/repo");
		expect(s.isMissingWorkspace()).toBe(false);

		s.markMissingWorkspace();
		expect(s.isMissingWorkspace()).toBe(true);

		s.reset();
		expect(s.isMissingWorkspace()).toBe(false);
	});

	it("clearMissingWorkspace returns a restored session to usable state", () => {
		const s = new SessionState();
		s.setDetection(true, "/repo");
		s.markMissingWorkspace();
		expect(s.isMissingWorkspace()).toBe(true);

		s.clearMissingWorkspace();
		expect(s.isMissingWorkspace()).toBe(false);
		expect(s.isActive()).toBe(true);
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

describe("SessionState interaction cursor", () => {
	it("defaults to null and can be set and cleared", () => {
		const s = new SessionState();
		expect(s.getCursorId()).toBeNull();

		s.setCursorId("entry-1");
		expect(s.getCursorId()).toBe("entry-1");

		s.setCursorId(null);
		expect(s.getCursorId()).toBeNull();
	});

	it("reset clears the cursor", () => {
		const s = new SessionState();
		s.setCursorId("entry-1");

		s.reset();

		expect(s.getCursorId()).toBeNull();
	});
});
