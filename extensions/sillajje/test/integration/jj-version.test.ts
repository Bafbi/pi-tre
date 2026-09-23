/**
 * The host jj version gate.
 *
 * The extension runs on hosts whose jj version we do not control. It warns
 * once when the running jj is outside the validated series list, and proceeds:
 * the typed parse failures are the real guard. These tests drive the warning
 * through the exec seam so no host needs an unusual jj installed.
 */

import { spawnSync } from "node:child_process";
import type { ExecFn } from "@pi-tre/sillajje-jj";
import { expect, it } from "vitest";
import { setTestPorts } from "../../src/index.js";
import { createRunner, describeJj, initRepo } from "./_helpers.js";

/** Delegate every command to the real process except `jj --version`. */
function versionStub(versionLine: string): ExecFn {
	return (cmd, args, opts) => {
		if (cmd === "jj" && args.includes("--version")) {
			return Promise.resolve({
				code: 0,
				stdout: `${versionLine}\n`,
				stderr: "",
				killed: false,
			});
		}
		const result = spawnSync(cmd, args, {
			cwd: opts?.cwd,
			encoding: "utf-8",
		});
		return Promise.resolve({
			code: result.status ?? 1,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			killed: false,
		});
	};
}

describeJj("sillajje jj version gate", () => {
	it("warns once when the host jj series is not in the validated list", async () => {
		const cwd = initRepo();
		const notifications: Array<[string, string]> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push([msg, type]),
		});

		setTestPorts({ exec: versionStub("jj 0.45.0") });
		try {
			await runner.emit({ type: "session_start", reason: "startup" });
		} finally {
			setTestPorts({ exec: undefined });
		}

		expect(
			notifications.some(
				([msg, type]) =>
					type === "warning" &&
					msg.includes("0.45.0") &&
					msg.includes("validated"),
			),
		).toBe(true);
	}, 15_000);

	it("stays silent when the host jj series is validated", async () => {
		const cwd = initRepo();
		const notifications: Array<[string, string]> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push([msg, type]),
		});

		await runner.emit({ type: "session_start", reason: "startup" });

		expect(
			notifications.some(([msg]) => msg.includes("validated list")),
		).toBe(false);
	}, 15_000);
});
