/**
 * Unit tests for the shared three-state session target resolution used by
 * the stamp, rebase, and fold subcommands.
 */

import { describe, expect, it, vi } from "vitest";
import { resolveSessionTarget } from "../../src/session-target";
import type { ExecFn, ExecResult } from "../../src/workspace";

/** Build an ExecFn from a command-key → result table. */
function execFrom(table: Record<string, ExecResult>): ExecFn {
	return vi.fn<ExecFn>().mockImplementation((cmd, args) => {
		const key = [cmd, ...args].join(" ");
		for (const [pattern, result] of Object.entries(table)) {
			if (key === pattern || key.startsWith(pattern)) {
				return Promise.resolve(result);
			}
		}
		return Promise.resolve({ code: 0, stdout: "", stderr: "" });
	});
}

const WORKSPACE_LIST = [
	"jj workspace list -T",
	'name ++ ":" ++ root ++ "\\n"',
].join(" ");

describe("resolveSessionTarget", () => {
	it("resolves an active foreign session to its workspace", async () => {
		const exec = execFrom({
			[WORKSPACE_LIST]: {
				code: 0,
				stdout: "sillajje-other: /ws/other\n",
				stderr: "",
			},
			"jj bookmark list": {
				code: 0,
				stdout: "sillajje/other: xyz\n",
				stderr: "",
			},
		});

		const target = await resolveSessionTarget(exec, "/repo", "other", {
			sessionKey: "current",
		});

		expect(target).toEqual({
			ok: true,
			sessionKey: "other",
			wsPath: "/ws/other",
		});
	});

	it("uses the stored workspace for the current session without a lookup", async () => {
		const exec = execFrom({});
		const execSpy = exec as unknown as ReturnType<typeof vi.fn>;

		const target = await resolveSessionTarget(exec, "/repo", "current", {
			sessionKey: "current",
			wsPath: "/ws/current",
		});

		expect(target).toEqual({
			ok: true,
			sessionKey: "current",
			wsPath: "/ws/current",
		});
		expect(execSpy).not.toHaveBeenCalled();
	});

	it("reports not-a-session when no sillajje bookmark exists", async () => {
		const exec = execFrom({
			[WORKSPACE_LIST]: { code: 0, stdout: "", stderr: "" },
			"jj bookmark list": { code: 0, stdout: "main: xyz\n", stderr: "" },
		});

		const target = await resolveSessionTarget(exec, "/repo", "ghost", {});

		expect(target).toEqual({ ok: false, reason: "not-a-session" });
	});

	it("reports archived when a bookmark exists without a workspace", async () => {
		const exec = execFrom({
			[WORKSPACE_LIST]: { code: 0, stdout: "", stderr: "" },
			"jj bookmark list": {
				code: 0,
				stdout: "sillajje/gone: xyz\n",
				stderr: "",
			},
		});

		const target = await resolveSessionTarget(exec, "/repo", "gone", {});

		expect(target).toEqual({ ok: false, reason: "archived" });
	});

	it("reports archived for the current session whose workspace is gone", async () => {
		// The stored workspace path was cleared (archive) but the bookmark
		// survives — the lookup finds nothing and the bookmark answers.
		const exec = execFrom({
			[WORKSPACE_LIST]: { code: 0, stdout: "", stderr: "" },
			"jj bookmark list": {
				code: 0,
				stdout: "sillajje/current: xyz\n",
				stderr: "",
			},
		});

		const target = await resolveSessionTarget(exec, "/repo", "current", {
			sessionKey: "current",
		});

		expect(target).toEqual({ ok: false, reason: "archived" });
	});
});
