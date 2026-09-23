import type { Model } from "@earendil-works/pi-ai/compat";
import type {
	AgentSession,
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	ModelRuntime,
	ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createInProcessBackend } from "../src/index.js";

/**
 * A scripted AgentSession covering the surface the backend uses. `emit`
 * drives agent events; `settle()` ends the run the way the agent loop
 * would; `abort()` is the cooperative abort.
 */
class FakeSession {
	listeners: Array<(event: never) => void> = [];
	promptCalls: string[] = [];
	promptError: Error | undefined;
	abortCalls = 0;
	disposeCalls = 0;
	private settleResolve: (() => void) | undefined;
	private readonly settlePromise = new Promise<void>((resolve) => {
		this.settleResolve = resolve;
	});

	subscribe(listener: (event: never) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	prompt(text: string): Promise<void> {
		this.promptCalls.push(text);
		if (this.promptError) return Promise.reject(this.promptError);
		return this.settlePromise;
	}

	async abort(): Promise<void> {
		this.abortCalls++;
		this.settle();
	}

	dispose(): void {
		this.disposeCalls++;
	}

	emit(event: Record<string, unknown>): void {
		for (const listener of [...this.listeners]) {
			listener(event as never);
		}
	}

	settle(): void {
		this.settleResolve?.();
	}
}

/**
 * A scripted session factory: records the options and hands back a
 * controller per created session.
 */
function fakeSessionFactory() {
	const created: Array<{
		options: CreateAgentSessionOptions;
		session: FakeSession;
	}> = [];

	const createSession = (
		options: CreateAgentSessionOptions,
	): Promise<CreateAgentSessionResult> => {
		const session = new FakeSession();
		created.push({ options, session });
		return Promise.resolve({
			session: session as unknown as AgentSession,
			extensionsResult: { extensions: [], errors: [] },
		} as unknown as CreateAgentSessionResult);
	};

	return { createSession, created };
}

/** Collect every event from the session until the event stream closes. */
async function collectEvents(
	session: ReturnType<ReturnType<typeof createInProcessBackend>["run"]>,
): Promise<unknown[]> {
	const events: unknown[] = [];
	for await (const event of session.events) {
		events.push(event);
	}
	return events;
}

describe("createInProcessBackend session wiring", () => {
	it("passes allowlist, denylist, cwd, and a fresh in-memory session to the factory", async () => {
		const { createSession, created } = fakeSessionFactory();
		const backend = createInProcessBackend({
			modelRuntime: stubRuntime([]),
			createSession:
				createSession as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		});

		const session = backend.run({
			prompt: "do a thing",
			cwd: "/tmp/ws",
			tools: ["read", "grep"],
			excludeTools: ["repo_query"],
		});
		void collectEvents(session);
		await Promise.resolve();
		await Promise.resolve();

		expect(created).toHaveLength(1);
		const { options } = created[0];
		expect(options.tools).toEqual(["read", "grep"]);
		expect(options.excludeTools).toEqual(["repo_query"]);
		expect(options.cwd).toBe("/tmp/ws");
		// Fresh, in-memory session: no session file.
		const sessionManager = options.sessionManager as unknown as
			| { sessionFile?: string }
			| undefined;
		expect(sessionManager?.sessionFile).toBeUndefined();
	});

	it("appends the task system prompt through a resource loader", async () => {
		const { createSession, created } = fakeSessionFactory();
		const loader = {
			getAppendSystemPrompt: () => ["be safe"],
		} as unknown as ResourceLoader;
		const loaderCalls: Array<{
			cwd: string;
			agentDir: string;
			appendSystemPrompt: string[];
		}> = [];
		const backend = createInProcessBackend({
			modelRuntime: stubRuntime([]),
			createResourceLoader: async (opts) => {
				loaderCalls.push(opts);
				return loader;
			},
			createSession:
				createSession as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		});

		void collectEvents(
			backend.run({
				prompt: "a",
				cwd: "/tmp/ws",
				systemPrompt: "be safe",
			}),
		);
		await new Promise((r) => setTimeout(r, 10));
		void collectEvents(backend.run({ prompt: "b", cwd: "/tmp/ws" }));
		await new Promise((r) => setTimeout(r, 10));

		expect(loaderCalls).toEqual([
			{
				cwd: "/tmp/ws",
				agentDir: expect.any(String),
				appendSystemPrompt: ["be safe"],
			},
		]);
		expect(created[0].options.resourceLoader).toBe(loader);
		expect(created[1].options.resourceLoader).toBeUndefined();
	});

	it("inherits the parent model and thinking level when the task carries none", async () => {
		const { createSession, created } = fakeSessionFactory();
		const parentModel = {
			id: "claude-opus-4-5",
			provider: "anthropic",
		} as Model<any>;
		const backend = createInProcessBackend({
			modelRuntime: stubRuntime([]),
			onModel: () => parentModel,
			onThinkingLevel: () => "high",
			createSession:
				createSession as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		});

		const session = backend.run({ prompt: "hello", cwd: "/tmp" });
		void collectEvents(session);
		await Promise.resolve();
		await Promise.resolve();

		expect(created[0].options.model).toBe(parentModel);
		expect(created[0].options.thinkingLevel).toBe("high");
	});

	it("passes a Model object through and resolves a model string against the runtime", async () => {
		const objectModel = { id: "m1", provider: "p1" } as Model<any>;
		const runtimeModel = { id: "m2", provider: "p2" } as Model<any>;
		const { createSession, created } = fakeSessionFactory();
		const backend = createInProcessBackend({
			modelRuntime: stubRuntime([runtimeModel]),
			createSession:
				createSession as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		});

		void collectEvents(
			backend.run({ prompt: "a", cwd: "/tmp", model: objectModel }),
		);
		void collectEvents(
			backend.run({ prompt: "b", cwd: "/tmp", model: "p2/m2" }),
		);
		void collectEvents(
			backend.run({ prompt: "c", cwd: "/tmp", model: "p2/m2:high" }),
		);
		await new Promise((r) => setTimeout(r, 20));

		expect(created[0].options.model).toBe(objectModel);
		expect(created[1].options.model).toBe(runtimeModel);
		// A `:thinking` suffix on the CLI string parses a thinking level.
		expect(created[2].options.model).toBe(runtimeModel);
		expect(created[2].options.thinkingLevel).toBe("high");
	});

	it("prefers a thinking suffix parsed from the task model over the inherited level", async () => {
		const runtimeModel = { id: "m2", provider: "p2" } as Model<any>;
		const { createSession, created } = fakeSessionFactory();
		const backend = createInProcessBackend({
			modelRuntime: stubRuntime([runtimeModel]),
			onThinkingLevel: () => "low",
			createSession:
				createSession as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		});

		void collectEvents(
			backend.run({ prompt: "a", cwd: "/tmp", model: "p2/m2:high" }),
		);
		await new Promise((r) => setTimeout(r, 20));

		expect(created[0].options.thinkingLevel).toBe("high");
	});

	it("gives each call a fresh session with no history leak", async () => {
		const { createSession, created } = fakeSessionFactory();
		const backend = createInProcessBackend({
			modelRuntime: stubRuntime([]),
			createSession:
				createSession as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		});

		const first = backend.run({ prompt: "first", cwd: "/tmp" });
		const firstEvents = collectEvents(first);
		await new Promise((r) => setTimeout(r, 10));
		created[0].session.settle();
		await firstEvents;

		const second = backend.run({ prompt: "second", cwd: "/tmp" });
		const secondEvents = collectEvents(second);
		await new Promise((r) => setTimeout(r, 10));
		created[1].session.settle();
		await secondEvents;

		expect(created).toHaveLength(2);
		expect(created[0].options.sessionManager).not.toBe(
			created[1].options.sessionManager,
		);
		expect(created[1].session.promptCalls).toEqual(["second"]);
	});
});

describe("createInProcessBackend event mapping", () => {
	it("maps text and thinking deltas, full text, usage, and stop reason", async () => {
		const { createSession, created } = fakeSessionFactory();
		const backend = createInProcessBackend({
			modelRuntime: stubRuntime([]),
			createSession:
				createSession as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		});

		const session = backend.run({ prompt: "hello", cwd: "/tmp" });
		const reading = collectEvents(session);
		await new Promise((r) => setTimeout(r, 10));

		const { session: child } = created[0];
		child.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Hello " },
		} as never);
		child.emit({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
		} as never);
		child.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hello world" }],
				usage: {
					input: 10,
					output: 5,
					totalTokens: 15,
					cost: { total: 0.01 },
				},
				stopReason: "stop",
			},
		} as never);
		child.settle();
		const events = await reading;

		expect(events).toContainEqual({
			type: "text",
			text: "Hello ",
			kind: "delta",
		});
		expect(events).toContainEqual({
			type: "thinking",
			text: "hmm",
			kind: "delta",
		});
		expect(events).toContainEqual({
			type: "text",
			text: "Hello world",
			kind: "full",
		});
		expect(events).toContainEqual({
			type: "stopReason",
			stopReason: "stop",
		});
		await expect(session.usage()).resolves.toEqual({
			turns: 1,
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.01,
			totalTokens: 15,
		});
	});

	it("reports an LLM error as an error event", async () => {
		const { createSession, created } = fakeSessionFactory();
		const backend = createInProcessBackend({
			modelRuntime: stubRuntime([]),
			createSession:
				createSession as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		});

		const session = backend.run({ prompt: "hello", cwd: "/tmp" });
		const reading = collectEvents(session);
		await new Promise((r) => setTimeout(r, 10));

		created[0].session.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
				stopReason: "error",
				errorMessage: "provider overloaded",
			},
		} as never);
		created[0].session.settle();
		const events = await reading;

		expect(events).toContainEqual({
			type: "error",
			message: "provider overloaded",
		});
	});

	it("surfaces a failed session creation as an error event and a finished exit", async () => {
		const backend = createInProcessBackend({
			modelRuntime: stubRuntime([]),
			createSession: (() =>
				Promise.reject(
					new Error("no auth configured"),
				)) as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		});

		const session = backend.run({ prompt: "hello", cwd: "/tmp" });
		const events = await collectEvents(session);

		expect(events).toContainEqual({
			type: "error",
			message: "no auth configured",
		});
		const exit = events[events.length - 1] as {
			type: string;
			code: number;
		};
		expect(exit.type).toBe("exit");
		expect(exit.code).toBe(1);
	});

	it("reports a code-1 exit when the prompt rejects", async () => {
		const session = new FakeSession();
		session.promptError = new Error("prompt exploded");
		const backend = createInProcessBackend({
			modelRuntime: stubRuntime([]),
			createSession: (() =>
				Promise.resolve({
					session: session as unknown as AgentSession,
					extensionsResult: { extensions: [], errors: [] },
				})) as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		});

		const events = await collectEvents(
			backend.run({ prompt: "hello", cwd: "/tmp" }),
		);

		expect(events).toContainEqual({
			type: "error",
			message: "prompt exploded",
		});
		const exit = events[events.length - 1] as {
			type: string;
			code: number;
		};
		expect(exit.type).toBe("exit");
		expect(exit.code).toBe(1);
	});
});

describe("createInProcessBackend timeout and abort", () => {
	it("watchdog aborts a hung turn and reports timedOut", async () => {
		const { createSession, created } = fakeSessionFactory();
		const backend = createInProcessBackend({
			modelRuntime: stubRuntime([]),
			createSession:
				createSession as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		});

		const session = backend.run({
			prompt: "hang",
			cwd: "/tmp",
			timeoutMs: 30,
		});
		const reading = collectEvents(session);
		await new Promise((r) => setTimeout(r, 10));

		// The turn never settles on its own; the watchdog must abort it.
		const events = await reading;

		expect(created[0].session.abortCalls).toBeGreaterThan(0);
		const exit = events[events.length - 1] as {
			type: string;
			timedOut: boolean;
			code: number;
		};
		expect(exit.type).toBe("exit");
		expect(exit.timedOut).toBe(true);
		// The exit contract reports -1 for a timed-out run.
		expect(exit.code).toBe(-1);
	}, 5_000);

	it("disposes a session that resolves after the timeout grace expires", async () => {
		let resolveSession: (() => void) | undefined;
		const session = new FakeSession();
		const createSession = (
			_options: CreateAgentSessionOptions,
		): Promise<CreateAgentSessionResult> =>
			new Promise<CreateAgentSessionResult>((resolve) => {
				resolveSession = () =>
					resolve({
						session: session as unknown as AgentSession,
						extensionsResult: { extensions: [], errors: [] },
					} as unknown as CreateAgentSessionResult);
			});
		const backend = createInProcessBackend({
			modelRuntime: stubRuntime([]),
			createSession:
				createSession as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		});

		const reading = collectEvents(
			backend.run({ prompt: "hang", cwd: "/tmp", timeoutMs: 10 }),
		);
		// Wait past the deadline plus the 1s abort grace so `finish()` runs
		// before the session factory resolves.
		await new Promise((r) => setTimeout(r, 1_100));
		resolveSession?.();
		await reading;
		// Let the late session settle so its cleanup runs.
		await new Promise((r) => setTimeout(r, 0));

		expect(session.disposeCalls).toBe(1);
	}, 5_000);

	it("aborts cooperatively through an external signal", async () => {
		const { createSession, created } = fakeSessionFactory();
		const backend = createInProcessBackend({
			modelRuntime: stubRuntime([]),
			createSession:
				createSession as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		});

		const signal = new AbortController();
		const session = backend.run({
			prompt: "long work",
			cwd: "/tmp",
			signal: signal.signal,
		});
		const reading = collectEvents(session);
		await new Promise((r) => setTimeout(r, 10));

		signal.abort();
		const events = await reading;

		expect(created[0].session.abortCalls).toBeGreaterThan(0);
		const exit = events[events.length - 1] as {
			type: string;
			aborted: boolean;
		};
		expect(exit.type).toBe("exit");
		expect(exit.aborted).toBe(true);
	}, 5_000);

	it("ends the run when the signal aborts during initialization", async () => {
		let resolveSession: (() => void) | undefined;
		const createdSession = new FakeSession();
		const createSession = (): Promise<CreateAgentSessionResult> =>
			new Promise<CreateAgentSessionResult>((resolve) => {
				resolveSession = () =>
					resolve({
						session: createdSession as unknown as AgentSession,
						extensionsResult: { extensions: [], errors: [] },
					} as unknown as CreateAgentSessionResult);
			});
		const backend = createInProcessBackend({
			modelRuntime: stubRuntime([]),
			createSession:
				createSession as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		});

		const signal = new AbortController();
		const reading = collectEvents(
			backend.run({ prompt: "x", cwd: "/tmp", signal: signal.signal }),
		);
		await new Promise((r) => setTimeout(r, 10));

		// The session factory has not resolved, yet abort must end the run.
		signal.abort();
		const events = await reading;

		const exit = events[events.length - 1] as {
			type: string;
			aborted: boolean;
		};
		expect(exit.type).toBe("exit");
		expect(exit.aborted).toBe(true);

		// A session that resolves after the abort is disposed.
		resolveSession?.();
		await new Promise((r) => setTimeout(r, 0));
		expect(createdSession.disposeCalls).toBe(1);
	}, 5_000);

	it("abort() on the session aborts the child run", async () => {
		const { createSession, created } = fakeSessionFactory();
		const backend = createInProcessBackend({
			modelRuntime: stubRuntime([]),
			createSession:
				createSession as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		});

		const session = backend.run({ prompt: "long work", cwd: "/tmp" });
		const reading = collectEvents(session);
		await new Promise((r) => setTimeout(r, 10));

		void session.abort();
		const events = await reading;

		expect(created[0].session.abortCalls).toBeGreaterThan(0);
		const exit = events[events.length - 1] as {
			type: string;
			aborted: boolean;
		};
		expect(exit.aborted).toBe(true);
	}, 5_000);

	it("disposes the session after the run ends", async () => {
		const { createSession, created } = fakeSessionFactory();
		const backend = createInProcessBackend({
			modelRuntime: stubRuntime([]),
			createSession:
				createSession as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		});

		const session = backend.run({ prompt: "hello", cwd: "/tmp" });
		const reading = collectEvents(session);
		await new Promise((r) => setTimeout(r, 10));
		created[0].session.settle();
		await reading;

		expect(created[0].session.disposeCalls).toBe(1);
	});
});

/**
 * A `ModelRuntime` fake carrying the given models.
 *
 * `ModelRuntime` is nominally sealed — private constructor and fields — so
 * no structural double can implement it; the single cast lives here at the
 * test boundary instead of at every call site. Only `getModels` is
 * reachable in these tests (through `resolveCliModel`); the `createSession`
 * double never touches the runtime.
 */
function stubRuntime(models: Model<any>[]): ModelRuntime {
	return { getModels: () => models } as unknown as ModelRuntime;
}
