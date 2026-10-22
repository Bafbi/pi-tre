/**
 * The core check gate's seam: fake ports, no repository, no process.
 *
 * Everything that depends on pi — the loop, the report, the waiver tool —
 * belongs to the adapter. This file pins the one run: selection, ordering,
 * path filtering, and the mapping from a command result to a verdict.
 */

import { describe, expect, it } from "vitest";
import {
	type CheckDefinition,
	type CommandRequest,
	type CommandResult,
	describeFailingChecks,
	failingChecks,
	gateIsRed,
	gateRanNothing,
	runGate,
	type StatusEvent,
} from "../src/index.js";

function check(
	name: string,
	overrides?: Partial<CheckDefinition>,
): CheckDefinition {
	return {
		name,
		command: `run-${name}`,
		triggers: ["settle"],
		timeoutMs: 300_000,
		paths: [],
		...overrides,
	};
}

function result(code: number, killed = false): CommandResult {
	return {
		code,
		stdout: `stdout-${code}`,
		stderr: `stderr-${code}`,
		killed,
		durationMs: 12,
	};
}

function fakePorts(byCommand: Record<string, CommandResult>) {
	const requests: CommandRequest[] = [];
	const statuses: StatusEvent[] = [];
	return {
		requests,
		statuses,
		ports: {
			command: {
				exec: async (request: CommandRequest) => {
					requests.push(request);
					return byCommand[request.command] ?? result(0);
				},
			},
			onStatus: (event: StatusEvent) => statuses.push(event),
		},
	};
}

describe("runGate", () => {
	it("runs the checks one trigger selects, in declared order", async () => {
		const { ports, requests } = fakePorts({});
		const gate = await runGate(ports, {
			checks: [
				check("b", { triggers: ["publish"], command: "b" }),
				check("a", { command: "a" }),
				check("c", { command: "c" }),
			],
			trigger: "settle",
			cwd: "/ws",
		});

		expect(requests.map((request) => request.command)).toEqual(["a", "c"]);
		expect(gate.results.map((entry) => entry.name)).toEqual(["a", "c"]);
		expect(gateIsRed(gate)).toBe(false);
	});

	it("runs every check once when the selector is all", async () => {
		const { ports, requests } = fakePorts({});
		await runGate(ports, {
			checks: [
				check("a", { triggers: ["settle"] }),
				check("b", { triggers: ["publish"] }),
				check("c", { triggers: [] }),
			],
			trigger: "all",
			cwd: "/ws",
		});

		expect(requests.map((request) => request.command)).toEqual([
			"run-a",
			"run-b",
			"run-c",
		]);
	});

	it("does not stop at the first failure", async () => {
		const { ports, requests } = fakePorts({
			"run-a": result(1),
			"run-b": result(0),
		});
		const gate = await runGate(ports, {
			checks: [check("a"), check("b")],
			trigger: "settle",
			cwd: "/ws",
		});

		expect(requests).toHaveLength(2);
		expect(gateIsRed(gate)).toBe(true);
		expect(failingChecks(gate).map((entry) => entry.name)).toEqual(["a"]);
	});

	it("maps a non-zero exit to failed with its exit code", async () => {
		const { ports } = fakePorts({ "run-a": result(2) });
		const gate = await runGate(ports, {
			checks: [check("a")],
			trigger: "settle",
			cwd: "/ws",
		});

		expect(gate.results[0]).toMatchObject({
			name: "a",
			status: "failed",
			exitCode: 2,
			durationMs: 12,
		});
	});

	it("maps a killed process to timed-out", async () => {
		const { ports } = fakePorts({ "run-a": result(1, true) });
		const gate = await runGate(ports, {
			checks: [check("a")],
			trigger: "settle",
			cwd: "/ws",
		});

		expect(gate.results[0]?.status).toBe("timed-out");
		expect(gateIsRed(gate)).toBe(true);
	});

	it("passes the check's timeout and the run's signal to the command", async () => {
		const { ports, requests } = fakePorts({});
		const controller = new AbortController();
		await runGate(ports, {
			checks: [check("a", { timeoutMs: 1234 })],
			trigger: "settle",
			cwd: "/ws",
			signal: controller.signal,
		});

		expect(requests[0]).toMatchObject({
			cwd: "/ws",
			timeoutMs: 1234,
			signal: controller.signal,
		});
	});

	it("waives an already aborted run without running a command", async () => {
		const { ports, requests } = fakePorts({});
		const controller = new AbortController();
		controller.abort();
		const gate = await runGate(ports, {
			checks: [check("a"), check("b")],
			trigger: "settle",
			cwd: "/ws",
			signal: controller.signal,
		});

		expect(requests).toHaveLength(0);
		expect(gate.results).toEqual([
			{
				name: "a",
				status: "waived",
				durationMs: 0,
				reason: "cancelled",
			},
			{
				name: "b",
				status: "waived",
				durationMs: 0,
				reason: "cancelled",
			},
		]);
	});

	it("waives the current check and every unfinished one when Escape aborts the run", async () => {
		const controller = new AbortController();
		const requests: CommandRequest[] = [];
		const gate = await runGate(
			{
				command: {
					exec: async (request) => {
						requests.push(request);
						controller.abort();
						return result(1, true);
					},
				},
				onStatus: () => {},
			},
			{
				checks: [check("a"), check("b")],
				trigger: "settle",
				cwd: "/ws",
				signal: controller.signal,
			},
		);

		expect(requests).toHaveLength(1);
		expect(gate.results.map((entry) => [entry.name, entry.status])).toEqual(
			[
				["a", "waived"],
				["b", "waived"],
			],
		);
		expect(
			gate.results.every((entry) => entry.reason === "cancelled"),
		).toBe(true);
	});

	it("emits a checking phase naming each selected check", async () => {
		const { ports, statuses } = fakePorts({});
		await runGate(ports, {
			checks: [check("a"), check("b")],
			trigger: "settle",
			cwd: "/ws",
		});

		expect(
			statuses.filter(
				(event) => event.kind === "phase" && event.code === "checking",
			),
		).toEqual([
			{ kind: "phase", code: "checking", target: "a" },
			{ kind: "phase", code: "checking", target: "b" },
		]);
	});

	it("runs no process for a check whose paths match nothing", async () => {
		const { ports, requests } = fakePorts({});
		const gate = await runGate(ports, {
			checks: [check("a", { paths: ["src/**"] })],
			trigger: "settle",
			cwd: "/ws",
			changedPaths: ["docs/readme.md"],
		});

		expect(requests).toHaveLength(0);
		expect(gate.results[0]?.status).toBe("skipped");
		expect(gateRanNothing(gate)).toBe(true);
	});

	it("runs a check when one changed path matches its globs", async () => {
		const { ports, requests } = fakePorts({});
		await runGate(ports, {
			checks: [check("a", { paths: ["src/**"] })],
			trigger: "settle",
			cwd: "/ws",
			changedPaths: ["docs/readme.md", "src/app.ts"],
		});

		expect(requests).toHaveLength(1);
	});

	it("runs a check with no paths filter regardless of the diff", async () => {
		const { ports, requests } = fakePorts({});
		await runGate(ports, {
			checks: [check("a")],
			trigger: "settle",
			cwd: "/ws",
			changedPaths: [],
		});

		expect(requests).toHaveLength(1);
	});

	it("runs every check when the caller has no diff to filter against", async () => {
		const { ports, requests } = fakePorts({});
		await runGate(ports, {
			checks: [check("a", { paths: ["src/**"] })],
			trigger: "settle",
			cwd: "/ws",
			changedPaths: undefined,
		});

		expect(requests).toHaveLength(1);
	});

	it("reports a command that could not start as failed without an exit code", async () => {
		const gate = await runGate(
			{
				command: {
					exec: async () => {
						throw new Error("spawn failed");
					},
				},
				onStatus: () => {},
			},
			{
				checks: [check("a")],
				trigger: "settle",
				cwd: "/ws",
			},
		);

		expect(gate.results[0]).toMatchObject({
			name: "a",
			status: "failed",
			durationMs: 0,
			reason: "spawn failed",
		});
		expect(gate.results[0]?.exitCode).toBeUndefined();
	});

	it("describes failures with exit codes and timeouts", async () => {
		const { ports } = fakePorts({
			"run-a": result(1),
			"run-b": result(1, true),
		});
		const gate = await runGate(ports, {
			checks: [check("a"), check("b")],
			trigger: "settle",
			cwd: "/ws",
		});

		expect(describeFailingChecks(gate)).toBe("a (exit 1), b (timed-out)");
	});

	it("selects nothing and runs nothing when no check carries the trigger", async () => {
		const { ports, requests } = fakePorts({});
		const gate = await runGate(ports, {
			checks: [check("a", { triggers: ["publish"] })],
			trigger: "settle",
			cwd: "/ws",
		});

		expect(requests).toHaveLength(0);
		expect(gate.results).toEqual([]);
		expect(gateIsRed(gate)).toBe(false);
		expect(gateRanNothing(gate)).toBe(true);
	});
});
