/**
 * The action contract: an action binds its ports at a factory and returns a
 * plain function. The port record is the capability surface, so a host that
 * cannot supply a port cannot build the action that needs it.
 */

import { describe, expect, it } from "vitest";
import {
	type Action,
	defaultSillajjeConfig,
	type HostPorts,
	type StatusEvent,
	type SubagentPort,
} from "../src/index.js";

/** A fixture action bound to the ports every host can supply. */
function createEchoAction(ports: HostPorts): Action<string, string> {
	return async (input) => {
		ports.onStatus({ kind: "phase", code: "echo" });
		return input;
	};
}

/** A fixture action that also needs the subagent port. */
function createGeneratingAction(
	ports: HostPorts & SubagentPort,
): Action<string, string> {
	return async (input) => {
		await ports.run({ prompt: input, model: "test-model" });
		return input;
	};
}

function hostPorts(onStatus: (event: StatusEvent) => void): HostPorts {
	return {
		jj: {} as HostPorts["jj"],
		workspaces: {} as HostPorts["workspaces"],
		config: defaultSillajjeConfig(),
		versions: { piVersion: "0.0.0", sillajjeVersion: "0.0.0" },
		onStatus,
	};
}

describe("the action contract", () => {
	it("runs an action with fake ports and records its statuses", async () => {
		const events: StatusEvent[] = [];
		const action = createEchoAction(
			hostPorts((event) => events.push(event)),
		);

		const result = await action("hello");

		expect(result).toBe("hello");
		expect(events).toEqual([{ kind: "phase", code: "echo" }]);
	});

	it("cannot build a subagent action from a bare HostPorts value", () => {
		const build = (ports: HostPorts) => {
			// @ts-expect-error - HostPorts lacks the subagent port
			return createGeneratingAction(ports);
		};
		expect(typeof build).toBe("function");
	});
});
