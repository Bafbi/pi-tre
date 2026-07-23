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
});
