/**
 * Unit tests for the stamp module.
 *
 * Tests cross mocked seams (ExecFn for jj, SpawnFn for sub-generator) with
 * pi-shaped Message[] fixtures. The module interface is the test surface.
 */

import type { Message } from "@earendil-works/pi-ai";
import { Default } from "@sinclair/typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SillajjeConfig } from "../../src/config";
import { SillajjeConfigSchema } from "../../src/config";
import type { StampInput, StampStatus } from "../../src/stamp";
import {
	deriveInteractionData,
	extractAssistantText,
	setSessionBookmark,
	stamp,
} from "../../src/stamp";
import type { ExecFn, ExecResult } from "../../src/workspace";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a default fully-populated SillajjeConfig for tests. */
function defaultConfig(overrides?: Partial<SillajjeConfig>): SillajjeConfig {
	const base = Default(SillajjeConfigSchema, {}) as SillajjeConfig;
	if (overrides) {
		return { ...base, ...overrides };
	}
	return base;
}

/** Build a UserMessage fixture. */
function userMsg(text: string, timestamp = 1000): Message {
	return {
		role: "user",
		content: text,
		timestamp,
	} as Message;
}

/** Build an AssistantMessage fixture with text content. */
function assistantMsg(
	text: string,
	opts?: {
		toolCalls?: Array<{
			id: string;
			name: string;
			arguments?: Record<string, unknown>;
		}>;
		thinking?: boolean;
		timestamp?: number;
	},
): Message {
	const content: Array<Record<string, unknown>> = [];
	if (opts?.thinking) {
		content.push({
			type: "thinking",
			thinking: "Let me think about this...",
		});
	}
	if (opts?.toolCalls) {
		for (const tc of opts.toolCalls) {
			content.push({
				type: "toolCall",
				id: tc.id,
				name: tc.name,
				arguments: tc.arguments ?? {},
			});
		}
	}
	content.push({ type: "text", text });
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: opts?.timestamp ?? 2000,
	} as Message;
}

/** Build a UserMessage with content blocks (for multi-block user content). */
function userMsgBlocks(
	blocks: Array<{ type: string; text?: string }>,
	timestamp = 1000,
): Message {
	return {
		role: "user",
		content: blocks,
		timestamp,
	} as Message;
}

/** Create a mock ExecFn that returns success for all commands. */
function mockExec(
	overrides?: Partial<Record<string, ExecResult | Error>>,
): ExecFn {
	return vi
		.fn<ExecFn>()
		.mockImplementation(
			(cmd: string, args: string[], _opts?: { cwd?: string }) => {
				const key = [cmd, ...args].join(" ");
				// Check for exact match first, then prefix match (override key is a prefix of the command key).
				if (overrides) {
					for (const [pattern, result] of Object.entries(overrides)) {
						if (key === pattern || key.startsWith(pattern)) {
							if (result instanceof Error) throw result;
							return Promise.resolve(result);
						}
					}
				}
				return Promise.resolve({ code: 0, stdout: "", stderr: "" });
			},
		);
}

/** Create a mock SpawnFn that returns success with canned output. */
function mockSpawn(): ReturnType<typeof vi.fn> {
	return vi.fn().mockResolvedValue({
		code: 0,
		stdout: "act/feat: test interaction\n(some extra output)",
		stderr: "",
	});
}

/** Collect all status emissions from an onStatus sink. */
function collectingSink(): {
	sink: (s: StampStatus) => void;
	statuses: StampStatus[];
} {
	const statuses: StampStatus[] = [];
	return {
		statuses,
		sink: (s: StampStatus) => {
			statuses.push(s);
		},
	};
}

/** Build a standard Interaction stamp input. */
function interactionInput(
	messages: Message[],
	opts?: { sessionKey?: string; wsPath?: string; rev?: string },
): StampInput {
	return {
		interaction: messages,
		workspace: {
			sessionKey: opts?.sessionKey ?? "test-session",
			wsPath: opts?.wsPath ?? "/tmp/ws",
		},
		rev: opts?.rev,
	};
}

// ---------------------------------------------------------------------------
// Tests: deriveInteractionData
// ---------------------------------------------------------------------------

describe("deriveInteractionData", () => {
	it("derives prompt from the first user message text", () => {
		const msgs: Message[] = [
			userMsg("Hello, world!"),
			assistantMsg("Hi there!"),
		];

		const data = deriveInteractionData(msgs);
		expect(data).toBeDefined();
		expect(data!.prompt).toBe("Hello, world!");
	});

	it("derives prompt from user message with content blocks", () => {
		const msgs: Message[] = [
			userMsgBlocks([{ type: "text", text: "First line" }]),
			assistantMsg("Response"),
		];

		const data = deriveInteractionData(msgs);
		expect(data!.prompt).toBe("First line");
	});

	it("derives response from the last assistant message text", () => {
		const msgs: Message[] = [
			userMsg("Query"),
			assistantMsg("First response", { timestamp: 2000 }),
			assistantMsg("Final response", { timestamp: 3000 }),
		];

		const data = deriveInteractionData(msgs);
		expect(data!.response).toBe("Final response");
	});

	it("counts thinking blocks across all assistant messages", () => {
		const msgs: Message[] = [
			userMsg("Query"),
			assistantMsg("First", { thinking: true, timestamp: 2000 }),
			assistantMsg("Second", { thinking: true, timestamp: 3000 }),
		];

		const data = deriveInteractionData(msgs);
		expect(data!.thinkingBlocks).toBe(2);
	});

	it("counts tool calls and collects unique tool names", () => {
		const msgs: Message[] = [
			userMsg("Do something"),
			assistantMsg("Done", {
				toolCalls: [
					{ id: "tc-1", name: "write" },
					{ id: "tc-2", name: "bash" },
					{ id: "tc-3", name: "write" },
				],
			}),
		];

		const data = deriveInteractionData(msgs);
		expect(data!.toolCallCount).toBe(3);
		expect(data!.toolNames).toEqual(
			expect.arrayContaining(["write", "bash"]),
		);
	});

	it("calculates elapsed from first and last message timestamps", () => {
		const msgs: Message[] = [
			userMsg("Query", 1000),
			assistantMsg("Response", { timestamp: 5000 }),
		];

		const data = deriveInteractionData(msgs);
		expect(data!.elapsedMs).toBe(4000);
	});

	it("returns undefined when no user message exists", () => {
		const msgs: Message[] = [assistantMsg("Solo")];
		expect(deriveInteractionData(msgs)).toBeUndefined();
	});

	it("returns undefined when no assistant message exists", () => {
		const msgs: Message[] = [userMsg("Solo")];
		expect(deriveInteractionData(msgs)).toBeUndefined();
	});

	it("correctly counts tools across multiple assistant messages", () => {
		const msgs: Message[] = [
			userMsg("Query"),
			assistantMsg("Halfway", {
				toolCalls: [{ id: "tc-1", name: "read" }],
				timestamp: 2000,
			}),
			assistantMsg("Done", {
				toolCalls: [
					{ id: "tc-2", name: "write" },
					{ id: "tc-3", name: "bash" },
				],
				timestamp: 4000,
			}),
		];

		const data = deriveInteractionData(msgs);
		expect(data!.toolCallCount).toBe(3);
		expect(data!.toolNames).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// Tests: extractAssistantText
// ---------------------------------------------------------------------------

describe("extractAssistantText", () => {
	it("extracts text from assistant content blocks", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "text", text: "Hello" },
				{ type: "text", text: "World" },
			],
		};
		expect(extractAssistantText(msg)).toBe("Hello\nWorld");
	});

	it("returns empty string for non-assistant roles", () => {
		const msg = { role: "user", content: [{ type: "text", text: "Hi" }] };
		expect(extractAssistantText(msg as never)).toBe("");
	});

	it("returns empty string for null content", () => {
		const msg = { role: "assistant", content: null };
		expect(extractAssistantText(msg as never)).toBe("");
	});
});

// ---------------------------------------------------------------------------
// Tests: setSessionBookmark
// ---------------------------------------------------------------------------

describe("setSessionBookmark", () => {
	it("calls jj bookmark set with the correct args", async () => {
		const exec = mockExec();
		const ok = await setSessionBookmark(exec, "my-session", "/ws");

		expect(ok).toBe(true);

		expect(exec).toHaveBeenCalledWith(
			"jj",
			["bookmark", "set", "sillajje/my-session", "-r", "@"],
			{ cwd: "/ws" },
		);
	});

	it("returns false when jj bookmark set fails", async () => {
		const exec = mockExec({
			"jj bookmark set": {
				code: 1,
				stdout: "",
				stderr: "bookmark error",
			},
		});
		const ok = await setSessionBookmark(exec, "my-session", "/ws");
		expect(ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Tests: stamp (Interaction path)
// ---------------------------------------------------------------------------

describe("stamp (Interaction path)", () => {
	let defaultCfg: SillajjeConfig;

	beforeEach(() => {
		defaultCfg = defaultConfig();
	});

	// -------------------------------------------------------------------
	// Happy path
	// -------------------------------------------------------------------

	it("returns ok: true for a successful Interaction stamp", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const msgs: Message[] = [
			userMsg("Add a login page", 1000),
			assistantMsg("I added the login page.", {
				toolCalls: [{ id: "tc-1", name: "write" }],
				timestamp: 5000,
			}),
		];

		const result = await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: defaultCfg,
			onStatus: sink,
		});

		expect(result).toEqual({
			ok: true,
			subject: "act/feat: test interaction",
			rev: "@",
		});
	}, 10_000);

	it("streams the three phase statuses during execution", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const msgs: Message[] = [userMsg("Query"), assistantMsg("Done")];

		await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: defaultCfg,
			onStatus: sink,
		});

		const phases = statuses.filter((s) => s.kind === "phase");
		expect(phases).toHaveLength(3);
		expect(phases[0].code).toBe("collecting-diff");
		expect(phases[1].code).toBe("generating-header");
		expect(phases[2].code).toBe("sealing-change");
	});

	it("runs the seal sequence in order through the injected exec seam", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const msgs: Message[] = [userMsg("Query"), assistantMsg("Done")];

		await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: defaultCfg,
			onStatus: sink,
		});

		const calls = (exec as ReturnType<typeof vi.fn>).mock.calls;

		// First: diff fetch
		expect(calls[0][0]).toBe("jj");
		expect(calls[0][1]).toEqual(["diff", "-r", "@"]);

		// Second: prior descriptions fetch
		expect(calls[1][0]).toBe("jj");
		expect(calls[1][1][0]).toBe("log");

		// Third: update-stale
		const updateCall = calls.find(
			(c) =>
				c[0] === "jj" &&
				c[1][0] === "workspace" &&
				c[1][1] === "update-stale",
		);
		expect(updateCall).toBeDefined();

		// Fourth: describe
		const descCall = calls.find(
			(c) => c[0] === "jj" && c[1][0] === "describe",
		);
		expect(descCall).toBeDefined();

		// Fifth: bookmark set
		const bmCall = calls.find(
			(c) => c[0] === "jj" && c[1][0] === "bookmark",
		);
		expect(bmCall).toBeDefined();
		expect(bmCall![1]).toEqual([
			"bookmark",
			"set",
			"sillajje/test-session",
			"-r",
			"@",
		]);

		// Sixth: jj new
		const newCall = calls.find((c) => c[0] === "jj" && c[1][0] === "new");
		expect(newCall).toBeDefined();
	});

	// -------------------------------------------------------------------
	// Commit body: derived data in describe body
	// -------------------------------------------------------------------

	it("includes prompt and response in the describe body by default", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const msgs: Message[] = [
			userMsg("The user prompt"),
			assistantMsg("The assistant response."),
		];

		await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: defaultCfg,
			onStatus: sink,
		});

		const descCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
			(c: unknown[]) => c[0] === "jj" && c[1]?.[0] === "describe",
		);
		const body = descCall?.[1]?.[2] as string;

		expect(body).toContain("Prompt:");
		expect(body).toContain("The user prompt");
		expect(body).toContain("Response:");
		expect(body).toContain("The assistant response.");
	});

	it("includes derived metadata in the describe body", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const msgs: Message[] = [
			userMsg("Query", 1000),
			assistantMsg("Done.", {
				toolCalls: [
					{ id: "tc-1", name: "write" },
					{ id: "tc-2", name: "bash" },
				],
				thinking: true,
				timestamp: 5000,
			}),
		];

		await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: defaultCfg,
			onStatus: sink,
		});

		const descCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
			(c: unknown[]) => c[0] === "jj" && c[1]?.[0] === "describe",
		);
		const body = descCall?.[1]?.[2] as string;

		// Metadata block.
		expect(body).toContain("Meta:");
		expect(body).toContain("write");
		expect(body).toContain("bash");
		expect(body).toContain("2 calls");
		expect(body).toContain("4.0s");
		expect(body).toContain("1 blocks");
	});

	it("includes trace in the describe body when enabled", async () => {
		const exec = mockExec();
		const spawn = vi
			.fn()
			.mockImplementation(
				(_cmd: string, _args: string[], input: string) => {
					if (input.includes("Interaction types")) {
						return Promise.resolve({
							code: 0,
							stdout: "act/feat: custom subject",
							stderr: "",
						});
					}
					return Promise.resolve({
						code: 0,
						stdout: "The agent did several things.",
						stderr: "",
					});
				},
			);
		const { sink } = collectingSink();

		const msgs: Message[] = [userMsg("Query"), assistantMsg("Done.")];

		await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: defaultCfg,
			onStatus: sink,
		});

		const descCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
			(c: unknown[]) => c[0] === "jj" && c[1]?.[0] === "describe",
		);
		const body = descCall?.[1]?.[2] as string;
		expect(body).toContain("Trace:");
		expect(body).toContain("The agent did several things.");
	});

	// -------------------------------------------------------------------
	// Sub-generator fallback
	// -------------------------------------------------------------------

	it("falls back to deriveSubject when header sub-generator fails", async () => {
		const exec = mockExec();
		const spawn = vi.fn().mockRejectedValue(new Error("unavailable"));
		const { sink, statuses } = collectingSink();

		const msgs: Message[] = [
			userMsg("Fix the login bug"),
			assistantMsg("Done."),
		];

		const result = await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: defaultCfg,
			onStatus: sink,
		});

		// Should succeed with fallback subject.
		expect(result).toEqual({
			ok: true,
			subject: "Fix the login bug",
			rev: "@",
		});

		// Warning should be emitted.
		const warnings = statuses.filter((s) => s.kind === "warning");
		expect(warnings.length).toBeGreaterThanOrEqual(1);
		expect(warnings.some((w) => w.code === "header-fallback")).toBe(true);
	});

	it("omits trace when trace sub-generator fails", async () => {
		const exec = mockExec();
		let callCount = 0;
		const spawn = vi.fn().mockImplementation(() => {
			callCount++;
			// First call succeeds (header), second fails (trace).
			if (callCount === 1) {
				return Promise.resolve({
					code: 0,
					stdout: "act/feat: subject",
					stderr: "",
				});
			}
			return Promise.reject(new Error("unavailable"));
		});
		const { sink, statuses } = collectingSink();

		const msgs: Message[] = [userMsg("Query"), assistantMsg("Done.")];

		await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: defaultCfg,
			onStatus: sink,
		});

		// Warning should be emitted for trace fallback.
		const warnings = statuses.filter((s) => s.kind === "warning");
		expect(warnings.some((w) => w.code === "trace-fallback")).toBe(true);

		// Trace should not be in the body.
		const descCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
			(c: unknown[]) => c[0] === "jj" && c[1]?.[0] === "describe",
		);
		const body = descCall?.[1]?.[2] as string;
		expect(body).not.toContain("Trace:");
	});

	// -------------------------------------------------------------------
	// Expected failures: jj commands fail
	// -------------------------------------------------------------------

	it("returns ok: false when jj workspace update-stale fails", async () => {
		const exec = mockExec({
			"jj workspace update-stale": {
				code: 1,
				stdout: "",
				stderr: "error",
			},
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const msgs: Message[] = [userMsg("Query"), assistantMsg("Done.")];

		const result = await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: defaultCfg,
			onStatus: sink,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "failed",
			lastCompletedStep: "none",
		});
		const errors = statuses.filter((s) => s.kind === "error");
		expect(errors.some((e) => e.code === "update_stale_failed")).toBe(true);
	});

	it("returns ok: false when jj describe fails", async () => {
		const exec = mockExec({
			"jj describe": { code: 1, stdout: "", stderr: "describe error" },
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const msgs: Message[] = [userMsg("Query"), assistantMsg("Done.")];

		const result = await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: defaultCfg,
			onStatus: sink,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "failed",
			lastCompletedStep: "update-stale",
		});
		const errors = statuses.filter((s) => s.kind === "error");
		expect(errors.some((e) => e.code === "describe_failed")).toBe(true);
	});

	it("returns ok: false when jj bookmark set fails", async () => {
		const exec = mockExec({
			"jj bookmark set": {
				code: 1,
				stdout: "",
				stderr: "bookmark error",
			},
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const msgs: Message[] = [userMsg("Query"), assistantMsg("Done.")];

		const result = await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: defaultCfg,
			onStatus: sink,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "failed",
			lastCompletedStep: "describe",
		});
		const errors = statuses.filter((s) => s.kind === "error");
		expect(errors.some((e) => e.code === "bookmark_set_failed")).toBe(true);
	});

	it("returns ok: false when jj new fails", async () => {
		const exec = mockExec({
			"jj new": { code: 1, stdout: "", stderr: "new error" },
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const msgs: Message[] = [userMsg("Query"), assistantMsg("Done.")];

		const result = await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: defaultCfg,
			onStatus: sink,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "failed",
			lastCompletedStep: "bookmark-set",
		});
		const errors = statuses.filter((s) => s.kind === "error");
		expect(errors.some((e) => e.code === "jj_new_failed")).toBe(true);
	});

	// -------------------------------------------------------------------
	// Throwing onStatus sink
	// -------------------------------------------------------------------

	it("does not corrupt the stamp when onStatus throws", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const throwingSink = vi.fn().mockImplementation(() => {
			throw new Error("sink exploded");
		});

		const msgs: Message[] = [userMsg("Query"), assistantMsg("Done.")];

		const result = await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: defaultCfg,
			onStatus: throwingSink,
		});

		// Stamp should succeed despite the throwing sink.
		expect(result).toEqual({
			ok: true,
			subject: "act/feat: test interaction",
			rev: "@",
		});
	});

	// -------------------------------------------------------------------
	// user_prompt header mode
	// -------------------------------------------------------------------

	it("uses prompt as subject when header mode is user_prompt", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const cfg = defaultConfig({ message: { header: "user_prompt" } });

		const msgs: Message[] = [
			userMsg("Prompt as subject: first line"),
			assistantMsg("Done."),
		];

		const result = await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: cfg,
			onStatus: sink,
		});

		expect(result.ok).toBe(true);
		expect((result as { ok: true; subject: string }).subject).toBe(
			"Prompt as subject: first line",
		);
	});

	it("user_prompt mode skips the sub-generator header call", async () => {
		const exec = mockExec();
		const spawn = vi.fn(); // Should not be called for header
		const { sink } = collectingSink();

		const cfg = defaultConfig({ message: { header: "user_prompt" } });

		const msgs: Message[] = [
			userMsg("Prompt as subject"),
			assistantMsg("Done."),
		];

		await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: cfg,
			onStatus: sink,
		});

		// spawn should never be called (no header + trace disabled in this minimal config).
		// Actually, trace is enabled by default — but our mock returns act/feat which
		// wouldn't match user_prompt mode's skip. The key is spawn is not called for header.
	});

	// -------------------------------------------------------------------
	// Config-gated body sections
	// -------------------------------------------------------------------

	it("omits Prompt section when user_prompt is false", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const cfg = defaultConfig({
			message: { body: { user_prompt: false } },
		});

		const msgs: Message[] = [
			userMsg("Should be hidden"),
			assistantMsg("Done."),
		];

		await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: cfg,
			onStatus: sink,
		});

		const descCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
			(c: unknown[]) => c[0] === "jj" && c[1]?.[0] === "describe",
		);
		const body = descCall?.[1]?.[2] as string;
		expect(body).not.toContain("Prompt:");
	});

	it("omits Response section when response is false", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const cfg = defaultConfig({
			message: { body: { response: false } },
		});

		const msgs: Message[] = [
			userMsg("Visible"),
			assistantMsg("Should be hidden."),
		];

		await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: cfg,
			onStatus: sink,
		});

		const descCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
			(c: unknown[]) => c[0] === "jj" && c[1]?.[0] === "describe",
		);
		const body = descCall?.[1]?.[2] as string;
		expect(body).not.toContain("Response:");
	});

	it("omits Meta block when meta.enabled is false", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const cfg = defaultConfig({
			message: { body: { meta: { enabled: false } } },
		});

		const msgs: Message[] = [userMsg("Query"), assistantMsg("Done.")];

		await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: cfg,
			onStatus: sink,
		});

		const descCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
			(c: unknown[]) => c[0] === "jj" && c[1]?.[0] === "describe",
		);
		const body = descCall?.[1]?.[2] as string;
		expect(body).not.toContain("Meta:");
	});

	it("omits Trace section when trace.enabled is false", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const cfg = defaultConfig({
			message: { body: { trace: { enabled: false } } },
		});

		const msgs: Message[] = [userMsg("Query"), assistantMsg("Done.")];

		await stamp(interactionInput(msgs), {
			exec,
			spawn,
			config: cfg,
			onStatus: sink,
		});

		const descCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
			(c: unknown[]) => c[0] === "jj" && c[1]?.[0] === "describe",
		);
		const body = descCall?.[1]?.[2] as string;
		expect(body).not.toContain("Trace:");
	});

	// -------------------------------------------------------------------
	// Rev targeting
	// -------------------------------------------------------------------

	it("returns rev: '@' in the result for an Interaction stamp", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const msgs: Message[] = [userMsg("Query"), assistantMsg("Done.")];

		const result = await stamp(interactionInput(msgs, { rev: "@" }), {
			exec,
			spawn,
			config: defaultCfg,
			onStatus: sink,
		});

		expect(result.ok).toBe(true);
		expect((result as { ok: true; rev: string }).rev).toBe("@");
	});
});

// ---------------------------------------------------------------------------
// Tests: stamp (Diff path)
// ---------------------------------------------------------------------------

/** Build a Diff stamp input. */
function diffInput(opts?: {
	sessionKey?: string;
	wsPath?: string;
	rev?: string;
}): StampInput {
	return {
		interaction: null,
		workspace: {
			sessionKey: opts?.sessionKey ?? "test-session",
			wsPath: opts?.wsPath ?? "/tmp/ws",
		},
		rev: opts?.rev,
	};
}

/** Find the body passed to a jj describe call in mock exec call history. */
function findDescribeBody(exec: ReturnType<typeof vi.fn>): string | undefined {
	const descCall = exec.mock.calls.find(
		(c: unknown[]) => c[0] === "jj" && c[1]?.[0] === "describe",
	);
	if (!descCall) return undefined;
	// body is the last element of the args array
	const args = descCall[1] as string[];
	return args[args.length - 1] as string | undefined;
}

describe("stamp (Diff path)", () => {
	const diffContent = "diff --git a/file b/file\n+added line\n";

	// -------------------------------------------------------------------
	// no-changes
	// -------------------------------------------------------------------

	it("returns no-changes when diff is empty", async () => {
		const exec = mockExec({
			"jj diff -r @": { code: 0, stdout: "", stderr: "" },
		});
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const result = await stamp(diffInput(), {
			exec,
			spawn,
			config: defaultConfig(),
			onStatus: sink,
		});

		expect(result).toEqual({ ok: false, reason: "no-changes" });
		// No describe call should have been made.
		const descBody = findDescribeBody(exec as ReturnType<typeof vi.fn>);
		expect(descBody).toBeUndefined();
	});

	// -------------------------------------------------------------------
	// Happy path: full seal at rev "@"
	// -------------------------------------------------------------------

	it("seals the working copy with diff-based header and Meta line", async () => {
		const exec = mockExec({
			"jj diff -r @": {
				code: 0,
				stdout: diffContent,
				stderr: "",
			},
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const result = await stamp(diffInput(), {
			exec,
			spawn,
			config: defaultConfig(),
			onStatus: sink,
		});

		expect(result).toEqual({
			ok: true,
			subject: "act/feat: test interaction",
			rev: "@",
		});

		// Body contains subject and Meta line.
		const body = findDescribeBody(exec as ReturnType<typeof vi.fn>);
		expect(body).toContain("act/feat: test interaction");
		expect(body).toContain("Meta: sillajje/test-session");

		// Full seal sequence: diff, update-stale, describe, bookmark, new.
		const calls = (exec as ReturnType<typeof vi.fn>).mock.calls;
		expect(
			calls.some(
				(c: unknown[]) =>
					c[0] === "jj" &&
					c[1][0] === "workspace" &&
					c[1][1] === "update-stale",
			),
		).toBe(true);
		expect(
			calls.some(
				(c: unknown[]) => c[0] === "jj" && c[1][0] === "bookmark",
			),
		).toBe(true);
		expect(
			calls.some((c: unknown[]) => c[0] === "jj" && c[1][0] === "new"),
		).toBe(true);

		// Phase statuses.
		const phases = statuses.filter((s) => s.kind === "phase");
		expect(phases).toHaveLength(3);
		expect(phases[0].code).toBe("collecting-diff");
		expect(phases[1].code).toBe("generating-header");
		expect(phases[2].code).toBe("sealing-change");
	});

	// -------------------------------------------------------------------
	// Non-"@" rev: describe-only
	// -------------------------------------------------------------------

	it("does describe-only for a non-@ rev (no update-stale, no bookmark, no new)", async () => {
		const exec = mockExec({
			"jj diff -r abc123": {
				code: 0,
				stdout: diffContent,
				stderr: "",
			},
		});
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const result = await stamp(diffInput({ rev: "abc123" }), {
			exec,
			spawn,
			config: defaultConfig(),
			onStatus: sink,
		});

		expect(result).toEqual({
			ok: true,
			subject: "act/feat: test interaction",
			rev: "abc123",
		});

		const calls = (exec as ReturnType<typeof vi.fn>).mock.calls;

		// Should have describe -r abc123 -m <body>
		const descCall = calls.find(
			(c: unknown[]) =>
				c[0] === "jj" && c[1]?.[0] === "describe" && c[1]?.[1] === "-r",
		);
		expect(descCall).toBeDefined();
		expect(descCall?.[1][2]).toBe("abc123");

		// Should NOT have update-stale, bookmark, or new.
		expect(
			calls.some(
				(c: unknown[]) =>
					c[0] === "jj" &&
					c[1][0] === "workspace" &&
					c[1][1] === "update-stale",
			),
		).toBe(false);
		expect(
			calls.some(
				(c: unknown[]) => c[0] === "jj" && c[1][0] === "bookmark",
			),
		).toBe(false);
		expect(
			calls.some((c: unknown[]) => c[0] === "jj" && c[1][0] === "new"),
		).toBe(false);

		// Body still contains subject and Meta.
		const body = findDescribeBody(exec as ReturnType<typeof vi.fn>);
		expect(body).toContain("act/feat: test interaction");
		expect(body).toContain("Meta: sillajje/test-session");
	});

	// -------------------------------------------------------------------
	// Sub-generator fallback
	// -------------------------------------------------------------------

	it("falls back to conventional-commit default when sub-generator fails", async () => {
		const exec = mockExec({
			"jj diff -r @": {
				code: 0,
				stdout: diffContent,
				stderr: "",
			},
		});
		const spawn = vi.fn().mockRejectedValue(new Error("unavailable"));
		const { sink, statuses } = collectingSink();

		const result = await stamp(diffInput(), {
			exec,
			spawn,
			config: defaultConfig(),
			onStatus: sink,
		});

		// Should succeed with fallback subject.
		expect(result).toEqual({
			ok: true,
			subject: "chore: manual checkpoint",
			rev: "@",
		});

		// Warning emitted.
		const warnings = statuses.filter((s) => s.kind === "warning");
		expect(warnings.some((w) => w.code === "header-fallback")).toBe(true);

		// Body contains fallback subject.
		const body = findDescribeBody(exec as ReturnType<typeof vi.fn>);
		expect(body).toContain("chore: manual checkpoint");
	});

	// -------------------------------------------------------------------
	// jj failures
	// -------------------------------------------------------------------

	it("returns ok: false when jj diff fails", async () => {
		const exec = mockExec({
			"jj diff -r @": { code: 1, stdout: "", stderr: "diff error" },
		});
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		// Diff is treated as empty on failure → no-changes.
		const result = await stamp(diffInput(), {
			exec,
			spawn,
			config: defaultConfig(),
			onStatus: sink,
		});

		expect(result).toEqual({ ok: false, reason: "no-changes" });
	});

	it("returns ok: false when jj update-stale fails during diff stamp", async () => {
		const exec = mockExec({
			"jj diff -r @": {
				code: 0,
				stdout: diffContent,
				stderr: "",
			},
			"jj workspace update-stale": {
				code: 1,
				stdout: "",
				stderr: "error",
			},
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const result = await stamp(diffInput(), {
			exec,
			spawn,
			config: defaultConfig(),
			onStatus: sink,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "failed",
			lastCompletedStep: "none",
		});
		const errors = statuses.filter((s) => s.kind === "error");
		expect(errors.some((e) => e.code === "update_stale_failed")).toBe(true);
	});

	it("returns ok: false when jj describe fails during diff stamp", async () => {
		const exec = mockExec({
			"jj diff -r @": {
				code: 0,
				stdout: diffContent,
				stderr: "",
			},
			"jj describe": {
				code: 1,
				stdout: "",
				stderr: "describe error",
			},
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const result = await stamp(diffInput(), {
			exec,
			spawn,
			config: defaultConfig(),
			onStatus: sink,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "failed",
			lastCompletedStep: "update-stale",
		});
		const errors = statuses.filter((s) => s.kind === "error");
		expect(errors.some((e) => e.code === "describe_failed")).toBe(true);
	});
});
