import { homedir } from "node:os";
import { sep } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionState } from "../../src/state";
import { formatPill } from "../../src/status-pill";

function makeState(overrides: {
	lifecycle?: "inactive" | "active" | "archived";
	workspacePath?: string;
	sessionId?: string;
}): SessionState {
	const s = new SessionState();
	if (
		overrides.lifecycle === "active" ||
		overrides.lifecycle === "archived"
	) {
		s.setDetection(true, "/fake/repo");
	}
	if (overrides.sessionId) {
		s.setSessionId(overrides.sessionId);
	}
	if (overrides.workspacePath) {
		s.setWorkspacePath(overrides.workspacePath);
	}
	if (overrides.lifecycle === "archived") {
		s.setArchived();
	}
	if (overrides.lifecycle === "inactive") {
		s.setInactive();
	}
	return s;
}

describe("formatPill", () => {
	it("returns undefined for inactive state", () => {
		const s = makeState({ lifecycle: "inactive" });
		expect(formatPill(s)).toBeUndefined();
	});

	it("shows active state with shortened workspace path under home", () => {
		const home = homedir();
		const s = makeState({
			lifecycle: "active",
			workspacePath: `${home}/.pi/sillajje/my-repo/abc123`,
		});
		expect(formatPill(s)).toBe(
			`sillajje: [active] ~${sep}.pi/sillajje/my-repo/abc123`,
		);
	});

	it("shows active state with full path when outside home", () => {
		const s = makeState({
			lifecycle: "active",
			workspacePath: "/tmp/workspaces/repo/sess",
		});
		expect(formatPill(s)).toBe(
			"sillajje: [active] /tmp/workspaces/repo/sess",
		);
	});

	it("returns undefined for active state without workspace path", () => {
		const s = makeState({ lifecycle: "active" });
		expect(formatPill(s)).toBeUndefined();
	});

	it("shows archived state with bookmark", () => {
		const s = makeState({
			lifecycle: "archived",
			sessionId: "abc123",
		});
		expect(formatPill(s)).toBe("sillajje: [archived] sillajje/abc123");
	});

	it("shows archived state with fallback when session ID missing", () => {
		const s = makeState({ lifecycle: "archived" });
		expect(formatPill(s)).toBe("sillajje: [archived] sillajje/?");
	});
});
