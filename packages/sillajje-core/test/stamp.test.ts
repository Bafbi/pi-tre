/**
 * Unit tests for the stamp action.
 *
 * Tests cross the action's ports: a mocked jj process under the typed facade,
 * a fake `Workspaces`, a fake `RunSubagent`, and a recording `onStatus`.
 * Interaction data is built directly — the adapter owns the transcript.
 */

import {
	createJj,
	type ExecFn,
	type ExecResult,
	type Jj,
} from "@pi-tre/sillajje-jj";
import type {
	CurrentSession,
	SessionTargetResolution,
	Workspaces,
} from "@pi-tre/sillajje-workspace";
import { Default } from "@sinclair/typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSetSessionBookmark,
	createStamp,
	type InteractionData,
	type ProvenanceVersions,
	type RevStampInput,
	type RunSubagent,
	type SessionStampInput,
	type SillajjeConfig,
	SillajjeConfigSchema,
	type StampResult,
	type StatusEvent,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a default fully-populated SillajjeConfig for tests. */
function defaultConfig(overrides?: Partial<SillajjeConfig>): SillajjeConfig {
	const base = Default(SillajjeConfigSchema, {}) as SillajjeConfig;
	if (!overrides) return base;
	// Deep-merge nested overrides so a single flag change (e.g. only
	// actions.stamp.body) keeps every other base setting — each
	// gating test then exercises exactly the flag it changes.
	return mergeDeep(base, overrides);
}

/** Recursive plain-object merge: overrides win; arrays and primitives replace. */
function mergeDeep<T>(base: T, overrides: unknown): T {
	if (Array.isArray(base) || Array.isArray(overrides)) {
		return (overrides ?? base) as T;
	}
	if (
		typeof base === "object" &&
		base !== null &&
		typeof overrides === "object" &&
		overrides !== null
	) {
		const out: Record<string, unknown> = {
			...(base as Record<string, unknown>),
		};
		for (const [key, value] of Object.entries(
			overrides as Record<string, unknown>,
		)) {
			out[key] = mergeDeep(out[key], value);
		}
		return out as T;
	}
	return (overrides ?? base) as T;
}

/** Build interaction data derived from a transcript. */
function interactionData(
	overrides?: Partial<InteractionData>,
): InteractionData {
	return {
		prompt: "Query",
		response: "Done.",
		toolNames: [],
		toolCallCount: 0,
		thinkingBlocks: 0,
		elapsedMs: 0,
		...overrides,
	};
}

/**
 * The head operation id the mock `jj op log` reports. Full hex, matching
 * the format jj 0.44 prints for `-T 'id'`.
 */
const HEAD_OP_ID =
	"e2cc9967a9be45acbc064cfb4d8556c530cacafc43f6e18dcf22e8ff754d4c703";

/** Deterministic 12-hex operation id for the mock's deferred steps. */
function mockOpId(n: number): string {
	return n.toString(16).padStart(12, "0");
}

/**
 * The line jj 0.44 prints for a deferred (`--no-integrate-operation`) step,
 * captured verbatim in a scratch repo. The seal's parser reads the op id
 * from this line; the test suite pins the format.
 */
function deferredOpLine(n: number): string {
	return `Operation left uncommitted because --no-integrate-operation was requested: ${mockOpId(n)}`;
}

/** A recorded `pi.exec` call: command, argv, options. */
type ExecCall = [command: string, args: string[], options?: { cwd?: string }];

/** The recorded calls on a mocked ExecFn. */
function mockCalls(exec: ExecFn): ExecCall[] {
	return (exec as unknown as { mock: { calls: ExecCall[] } }).mock.calls;
}

/** Create a mock ExecFn that returns success for all commands. */
function mockExec(overrides?: Record<string, ExecResult | Error>): ExecFn {
	let deferredCount = 0;
	return vi
		.fn<ExecFn>()
		.mockImplementation(
			(cmd: string, args: string[], _opts?: { cwd?: string }) => {
				// The jj package adds --color=never to every call; strip it so
				// existing command-keyed overrides keep matching.
				const key = [
					cmd,
					...args.filter((a) => a !== "--color=never"),
				].join(" ");
				// Check for exact match first, then prefix match (override key is a prefix of the command key).
				if (overrides) {
					for (const [pattern, result] of Object.entries(overrides)) {
						if (key === pattern || key.startsWith(pattern)) {
							if (result instanceof Error) throw result;
							return Promise.resolve(result);
						}
					}
				}
				if (key === "jj op log -n 1 --no-graph -T id") {
					return Promise.resolve({
						code: 0,
						stdout: `${HEAD_OP_ID}\n`,
						stderr: "",
					});
				}
				if (args.includes("--no-integrate-operation")) {
					deferredCount += 1;
					return Promise.resolve({
						code: 0,
						stdout: "",
						stderr: `${deferredOpLine(deferredCount)}\n`,
					});
				}
				return Promise.resolve({ code: 0, stdout: "", stderr: "" });
			},
		);
}

/** Create a mock subagent backend that returns canned output. */
function mockSpawn(): ReturnType<typeof vi.fn> {
	return vi.fn().mockResolvedValue({
		text: "act/feat: test interaction\n(some extra output)",
	});
}

/** Collect all status emissions from an onStatus sink. */
function collectingSink(): {
	sink: (event: StatusEvent) => void;
	statuses: StatusEvent[];
} {
	const statuses: StatusEvent[] = [];
	return {
		statuses,
		sink: (event: StatusEvent) => {
			statuses.push(event);
		},
	};
}

/** The env dependency the adapter reads once at activation. */
const TEST_ENV: ProvenanceVersions = {
	piVersion: "test-pi",
	sillajjeVersion: "test-sillajje",
};

// ---------------------------------------------------------------------------
// Fake Workspaces
// ---------------------------------------------------------------------------

/** A fake `Workspaces` with a canned target resolution. */
function fakeWorkspaces(
	resolve: (
		target: string,
		current: CurrentSession,
	) => Promise<SessionTargetResolution>,
): Workspaces {
	return {
		owner: "test-owner/host",
		sessionKey: (target) =>
			target.includes("/") ? target : `test-owner/${target}`,
		ownerOf: (key) => key.split("/").slice(0, 2).join("/"),
		unqualified: (key) => key.split("/").slice(2).join("/"),
		workspaceName: (key) => `sillajje/${key}`,
		bookmarkName: (key) => `sillajje/${key}`,
		workspacePath: (key) => `/tmp/ws-root/${key}`,
		ensure: async () => ({ ok: false, reason: "archived" }),
		lookup: async () => undefined,
		archive: async () => ({ status: "already-gone" }),
		unarchive: async () => {
			throw new Error("unarchive is not used by the stamp tests");
		},
		resolveTarget: resolve,
		resolveBaseSource: async () => ({
			ok: false,
			reason: "not-a-session",
		}),
	};
}

/** A fake `Workspaces` that resolves every session target to one path. */
function ws(wsPath = "/tmp/ws", sessionKey = "test-session"): Workspaces {
	return fakeWorkspaces(async () => ({ ok: true, sessionKey, wsPath }));
}

// ---------------------------------------------------------------------------
// Action bindings
// ---------------------------------------------------------------------------

interface TestDeps {
	jj: Jj;
	run: RunSubagent;
	config: SillajjeConfig;
	env: ProvenanceVersions;
	onStatus: (event: StatusEvent) => void;
	workspaces?: Workspaces;
}

function ports(deps: TestDeps) {
	return {
		jj: deps.jj,
		run: deps.run,
		config: deps.config,
		versions: deps.env,
		onStatus: deps.onStatus,
		workspaces: deps.workspaces ?? ws(),
	};
}

function stampSession(
	input: SessionStampInput,
	deps: TestDeps,
): Promise<StampResult> {
	return createStamp(ports(deps)).session(input);
}

function stampRev(input: RevStampInput, deps: TestDeps): Promise<StampResult> {
	return createStamp(ports(deps)).rev(input);
}

function setSessionBookmark(
	jj: Jj,
	sessionKey: string,
	wsPath: string,
): Promise<boolean> {
	return createSetSessionBookmark({
		jj,
		workspaces: fakeWorkspaces(async () => ({
			ok: true,
			sessionKey,
			wsPath,
		})),
		onStatus: () => {},
	})({ target: sessionKey });
}

/** Build a Rev stamp input bound to a working directory. */
function revInput(rev: string, cwd = "/tmp/ws"): RevStampInput {
	return { cwd, rev };
}

/** Build a standard Interaction stamp input. */
function interactionInput(
	data: Partial<InteractionData> = {},
): SessionStampInput {
	return { target: "test-session", interaction: interactionData(data) };
}

/** Build a manual (diff-only) session stamp input. */
function diffInput(opts?: { target?: string }): SessionStampInput {
	return { target: opts?.target ?? "test-session" };
}

/** Find the body passed to a jj describe call in mock exec call history. */
function findDescribeBody(exec: ExecFn): string | undefined {
	const descCall = mockCalls(exec).find(
		(c) => c[0] === "jj" && c[1]?.[0] === "describe",
	);
	if (!descCall) return undefined;
	// The jj facade appends the transaction flags after the mutation argv, so
	// the body is the token after `-m`, not the last element.
	const args = descCall![1];
	const flag = args.indexOf("-m");
	return flag === -1 ? undefined : args[flag + 1];
}

// ---------------------------------------------------------------------------
// Tests: createSetSessionBookmark
// ---------------------------------------------------------------------------

describe("createSetSessionBookmark", () => {
	it("calls jj bookmark set with the correct args", async () => {
		const exec = mockExec();
		const ok = await setSessionBookmark(
			createJj(exec),
			"my-session",
			"/ws",
		);

		expect(ok).toBe(true);

		expect(exec).toHaveBeenCalledWith(
			"jj",
			[
				"bookmark",
				"set",
				"sillajje/my-session",
				"-r",
				"@",
				"--color=never",
			],
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

		const ok = await setSessionBookmark(
			createJj(exec),
			"my-session",
			"/ws",
		);
		expect(ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Tests: stamp (Interaction path)
// ---------------------------------------------------------------------------

describe("stampSession (interaction context)", () => {
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

		const result = await stampSession(
			interactionInput({
				prompt: "Add a login page",
				response: "I added the login page.",
				toolNames: ["write"],
				toolCallCount: 1,
				elapsedMs: 4000,
			}),
			{
				jj: createJj(exec),
				run: spawn,
				config: defaultCfg,
				env: TEST_ENV,
				onStatus: sink,
			},
		);

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

		await stampSession(interactionInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultCfg,
			env: TEST_ENV,
			onStatus: sink,
		});

		const phases = statuses.filter((s) => s.kind === "phase");
		expect(phases).toHaveLength(3);
		expect(phases[0]!.code).toBe("collecting-diff");
		expect(phases[1]!.code).toBe("generating-header");
		expect(phases[2]!.code).toBe("sealing-change");
	});

	it("runs the seal sequence in order through the injected exec seam", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		await stampSession(interactionInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultCfg,
			env: TEST_ENV,
			onStatus: sink,
		});

		const calls = mockCalls(exec);

		// First: diff fetch
		expect(calls[0]![0]).toBe("jj");
		expect(calls[0]![1]).toEqual(["diff", "-r", "@", "--color=never"]);

		// Second: prior descriptions fetch
		expect(calls[1]![0]).toBe("jj");
		expect(calls[1]![1][0]).toBe("log");

		// The transactional seal follows, chained on captured op ids.
		const descCall = calls.find(
			(c) => c[0] === "jj" && c[1][0] === "describe",
		);
		expect(descCall).toBeDefined();
		const bmCall = calls.find(
			(c) => c[0] === "jj" && c[1][0] === "bookmark",
		);
		expect(bmCall).toBeDefined();
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

		await stampSession(
			interactionInput({
				prompt: "The user prompt",
				response: "The assistant response.",
			}),
			{
				jj: createJj(exec),
				run: spawn,
				config: defaultCfg,
				env: TEST_ENV,
				onStatus: sink,
			},
		);

		const body = findDescribeBody(exec);

		expect(body).toContain("Prompt:");
		expect(body).toContain("The user prompt");
		expect(body).toContain("Response:");
		expect(body).toContain("The assistant response.");
	});

	it("includes derived interaction fields in the Loop section", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		await stampSession(
			interactionInput({
				prompt: "Query",
				response: "Done.",
				toolNames: ["write", "bash"],
				toolCallCount: 2,
				thinkingBlocks: 1,
				elapsedMs: 4000,
			}),
			{
				jj: createJj(exec),
				run: spawn,
				config: defaultCfg,
				env: TEST_ENV,
				onStatus: sink,
			},
		);

		const body = findDescribeBody(exec);

		// Provenance is the source; the interaction fields are the Loop.
		expect(body).toContain("Meta: source: interaction");
		expect(body).toContain("Loop:");
		expect(body).toContain("write");
		expect(body).toContain("bash");
		expect(body).toContain("2 calls");
		expect(body).toContain("4.0s");
		expect(body).toContain("1 blocks");
	});

	it("includes trace in the describe body when enabled", async () => {
		const exec = mockExec();
		const spawn = vi.fn().mockImplementation(({ prompt }) => {
			if (prompt.includes("Interaction types")) {
				return Promise.resolve({ text: "act/feat: custom subject" });
			}
			return Promise.resolve({ text: "The agent did several things." });
		});
		const { sink } = collectingSink();

		await stampSession(interactionInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultCfg,
			env: TEST_ENV,
			onStatus: sink,
		});

		const body = findDescribeBody(exec);
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

		const result = await stampSession(
			interactionInput({
				prompt: "Fix the login bug",
				response: "Done.",
			}),
			{
				jj: createJj(exec),
				run: spawn,
				config: defaultCfg,
				env: TEST_ENV,
				onStatus: sink,
			},
		);

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
				return Promise.resolve({ text: "act/feat: subject" });
			}
			return Promise.reject(new Error("unavailable"));
		});
		const { sink, statuses } = collectingSink();

		await stampSession(interactionInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultCfg,
			env: TEST_ENV,
			onStatus: sink,
		});

		// Warning should be emitted for trace fallback.
		const warnings = statuses.filter((s) => s.kind === "warning");
		expect(warnings.some((w) => w.code === "trace-fallback")).toBe(true);

		// Trace should not be in the body.
		const body = findDescribeBody(exec);
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

		const result = await stampSession(interactionInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultCfg,
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "failed",
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

		const result = await stampSession(interactionInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultCfg,
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "failed",
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

		const result = await stampSession(interactionInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultCfg,
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "failed",
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

		const result = await stampSession(interactionInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultCfg,
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "failed",
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

		const result = await stampSession(interactionInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultCfg,
			env: TEST_ENV,
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

		const cfg = defaultConfig({
			actions: { stamp: { header: { mode: "user_prompt" } } },
		});

		const result = await stampSession(
			interactionInput({
				prompt: "Prompt as subject: first line",
				response: "Done.",
			}),
			{
				jj: createJj(exec),
				run: spawn,
				config: cfg,
				env: TEST_ENV,
				onStatus: sink,
			},
		);

		expect(result.ok).toBe(true);
		expect((result as { ok: true; subject: string }).subject).toBe(
			"Prompt as subject: first line",
		);
	});

	it("user_prompt mode skips the sub-generator header call", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const cfg = defaultConfig({
			actions: { stamp: { header: { mode: "user_prompt" } } },
		});

		await stampSession(
			interactionInput({
				prompt: "Prompt as subject",
				response: "Done.",
			}),
			{
				jj: createJj(exec),
				run: spawn,
				config: cfg,
				env: TEST_ENV,
				onStatus: sink,
			},
		);

		// The trace sub-generator still runs (enabled by default) — assert it
		// ran, but never with the header prompt.
		const spawnCalls = (spawn as ReturnType<typeof vi.fn>).mock
			.calls as Array<[{ prompt: string }]>;
		expect(spawnCalls.length).toBe(1);
		expect(String(spawnCalls[0]![0]?.prompt)).not.toContain(
			"Produce a single subject line for this interaction.",
		);
	});

	// -------------------------------------------------------------------
	// Config-gated body sections
	// -------------------------------------------------------------------

	it("omits the Prompt section when it is not in the body", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const cfg = defaultConfig({
			actions: { stamp: { body: ["trace", "meta", "loop", "response"] } },
		});

		await stampSession(
			interactionInput({ prompt: "Should be hidden", response: "Done." }),
			{
				jj: createJj(exec),
				run: spawn,
				config: cfg,
				env: TEST_ENV,
				onStatus: sink,
			},
		);

		const body = findDescribeBody(exec);
		expect(body).not.toContain("Prompt:");
	});

	it("omits the Response section when it is not in the body", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const cfg = defaultConfig({
			actions: { stamp: { body: ["trace", "meta", "loop", "prompt"] } },
		});

		await stampSession(
			interactionInput({
				prompt: "Visible",
				response: "Should be hidden.",
			}),
			{
				jj: createJj(exec),
				run: spawn,
				config: cfg,
				env: TEST_ENV,
				onStatus: sink,
			},
		);

		const body = findDescribeBody(exec);
		expect(body).not.toContain("Response:");
	});

	it("omits the Loop section when it is not in the body", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const cfg = defaultConfig({
			actions: {
				stamp: { body: ["trace", "meta", "prompt", "response"] },
			},
		});

		await stampSession(interactionInput(), {
			jj: createJj(exec),
			run: spawn,
			config: cfg,
			env: TEST_ENV,
			onStatus: sink,
		});

		const body = findDescribeBody(exec);
		expect(body).toContain("Meta:");
		expect(body).not.toContain("Loop:");
	});

	it("omits the Trace section when it is not in the body", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const cfg = defaultConfig({
			actions: {
				stamp: { body: ["meta", "loop", "prompt", "response"] },
			},
		});

		await stampSession(interactionInput(), {
			jj: createJj(exec),
			run: spawn,
			config: cfg,
			env: TEST_ENV,
			onStatus: sink,
		});

		const body = findDescribeBody(exec);
		expect(body).not.toContain("Trace:");
	});
});

// ---------------------------------------------------------------------------
// Tests: stamp (Diff path)
// ---------------------------------------------------------------------------

describe("stampSession (manual context)", () => {
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

		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toEqual({ ok: false, reason: "no-changes" });
		// No describe call should have been made.
		const descBody = findDescribeBody(exec);
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

		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toEqual({
			ok: true,
			subject: "act/feat: test interaction",
			rev: "@",
		});

		// Body contains subject and the provenance block naming the
		// stamped session's trail.
		const body = findDescribeBody(exec);
		expect(body).toContain("act/feat: test interaction");
		expect(body).toContain("Meta: source: diff");
		expect(body).toContain("sillajje/test-session");
		expect(body).toContain("pi: test-pi");
		expect(body).toContain("sillajje: test-sillajje");

		// Full seal sequence: diff, update-stale, describe, bookmark, new.
		const calls = mockCalls(exec);
		expect(
			calls.some(
				(c) =>
					c[0] === "jj" &&
					c[1][0] === "workspace" &&
					c[1][1] === "update-stale",
			),
		).toBe(true);
		expect(calls.some((c) => c[0] === "jj" && c[1][0] === "bookmark")).toBe(
			true,
		);
		expect(calls.some((c) => c[0] === "jj" && c[1][0] === "new")).toBe(
			true,
		);

		// Phase statuses.
		const phases = statuses.filter((s) => s.kind === "phase");
		expect(phases).toHaveLength(3);
		expect(phases[0]!.code).toBe("collecting-diff");
		expect(phases[1]!.code).toBe("generating-header");
		expect(phases[2]!.code).toBe("sealing-change");
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

		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
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
		const body = findDescribeBody(exec);
		expect(body).toContain("chore: manual checkpoint");
	});

	// -------------------------------------------------------------------
	// jj failures
	// -------------------------------------------------------------------

	it("relays a failed jj diff as diff_fetch_failed", async () => {
		const exec = mockExec({
			"jj diff -r @": { code: 1, stdout: "", stderr: "diff error" },
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		// A non-zero `jj diff` exit is jj's call to explain — the module
		// relays its stderr instead of reading the failure as empty (a
		// corrupt workspace or missing jj is not "nothing to stamp").
		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toEqual({ ok: false, reason: "failed" });
		expect(statuses).toContainEqual({
			kind: "error",
			code: "diff_fetch_failed",
			message: expect.stringContaining("diff error"),
		});
	});

	it("returns failed when the jj diff fetch rejects", async () => {
		const exec = mockExec();
		(
			exec as unknown as { mockRejectedValueOnce: (v: unknown) => void }
		).mockRejectedValueOnce(new Error("exec adapter down"));
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		// A rejected diff fetch is a real failure — distinct from no-changes.
		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toEqual({ ok: false, reason: "failed" });
		expect(
			statuses.some(
				(s) => s.kind === "error" && s.code === "diff_fetch_failed",
			),
		).toBe(true);
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

		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "failed",
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

		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toMatchObject({
			ok: false,
			reason: "failed",
		});
		const errors = statuses.filter((s) => s.kind === "error");
		expect(errors.some((e) => e.code === "describe_failed")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: stampRev (Rev stamp entry point)
// ---------------------------------------------------------------------------

describe("stampRev", () => {
	const diffContent = "diff --git a/file b/file\n+added line\n";

	// -------------------------------------------------------------------
	// Happy path
	// -------------------------------------------------------------------

	it("describes the target rev with a generated header and provenance", async () => {
		const exec = mockExec({
			"jj diff -r abc123": {
				code: 0,
				stdout: diffContent,
				stderr: "",
			},
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const result = await stampRev(revInput("abc123"), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		// Value result carries the subject and the rev.
		expect(result).toEqual({
			ok: true,
			subject: "act/feat: test interaction",
			rev: "abc123",
		});

		const calls = mockCalls(exec);

		// Three jj calls: the diff fetch, the describe, and the operation read
		// that returns the describe's MutationResult. No seal — no update-stale,
		// no bookmark set, no jj new.
		expect(calls).toHaveLength(3);
		expect(calls[0]![0]).toBe("jj");
		expect(calls[0]![1]).toEqual(["diff", "-r", "abc123", "--color=never"]);

		const descCall = calls[1];
		expect(descCall![0]).toBe("jj");
		expect(descCall![1][0]).toBe("describe");
		expect(descCall![1].slice(1, 4)).toEqual(["-r", "abc123", "-m"]);

		// No seal-side calls exist.
		expect(
			calls.some(
				(c) =>
					c[0] === "jj" &&
					(c[1][0] === "bookmark" ||
						c[1][0] === "new" ||
						(c[1][0] === "workspace" &&
							c[1][1] === "update-stale")),
			),
		).toBe(false);

		// Phase statuses stream in order.
		const phases = statuses.filter((s) => s.kind === "phase");
		expect(phases.map((p) => p.code)).toEqual([
			"collecting-diff",
			"generating-header",
			"sealing-change",
		]);
	});

	it("accepts -r @ and stays describe-only", async () => {
		const exec = mockExec({
			"jj diff -r @": {
				code: 0,
				stdout: diffContent,
				stderr: "",
			},
		});
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const result = await stampRev(revInput("@"), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toEqual({
			ok: true,
			subject: "act/feat: test interaction",
			rev: "@",
		});
		const calls = mockCalls(exec);
		expect(calls.some((c) => c[0] === "jj" && c[1][0] === "new")).toBe(
			false,
		);
		expect(calls.some((c) => c[0] === "jj" && c[1][0] === "bookmark")).toBe(
			false,
		);
	});

	// -------------------------------------------------------------------
	// Provenance metadata block
	// -------------------------------------------------------------------

	it("renders the provenance block from the call and deps.env", async () => {
		const exec = mockExec({
			"jj diff -r abc123": {
				code: 0,
				stdout: diffContent,
				stderr: "",
			},
		});
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		await stampRev(revInput("abc123"), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		const body = findDescribeBody(exec);
		expect(body).toContain("Meta: source: rev");
		expect(body).toContain("rev: abc123");
		// Model from the sub-generator config default.
		expect(body).toContain("model: openai/gpt-4o-mini");
		// Versions from deps.env.
		expect(body).toContain("pi: test-pi");
		expect(body).toContain("sillajje: test-sillajje");
	});

	it("records the header fallback in the provenance block", async () => {
		const exec = mockExec({
			"jj diff -r abc123": {
				code: 0,
				stdout: diffContent,
				stderr: "",
			},
		});
		const spawn = vi.fn().mockRejectedValue(new Error("unavailable"));
		const { sink, statuses } = collectingSink();

		const result = await stampRev(revInput("abc123"), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		// Still succeeds with the fallback subject.
		expect(result.ok).toBe(true);
		expect(
			statuses.some(
				(s) => s.kind === "warning" && s.code === "header-fallback",
			),
		).toBe(true);

		const body = findDescribeBody(exec);
		expect(body).toContain("fallback: header");
	});

	it("omits the Meta section when it is not in the body", async () => {
		const exec = mockExec({
			"jj diff -r abc123": {
				code: 0,
				stdout: diffContent,
				stderr: "",
			},
		});
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const cfg = defaultConfig({
			actions: {
				stamp: { body: ["trace", "loop", "prompt", "response"] },
			},
		});

		await stampRev(revInput("abc123"), {
			jj: createJj(exec),
			run: spawn,
			config: cfg,
			env: TEST_ENV,
			onStatus: sink,
		});

		const body = findDescribeBody(exec);
		expect(body).not.toContain("Meta:");
		expect(body).not.toContain("Loop:");
	});

	// -------------------------------------------------------------------
	// Expected failures
	// -------------------------------------------------------------------

	it("returns no-changes on an empty diff before any mutation", async () => {
		const exec = mockExec({
			"jj diff -r abc123": { code: 0, stdout: "", stderr: "" },
		});
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const result = await stampRev(revInput("abc123"), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toEqual({ ok: false, reason: "no-changes" });
		// The describe (the only mutating call) never happened.
		const descBody = findDescribeBody(exec);
		expect(descBody).toBeUndefined();
		// The sub-generator never ran either.
		expect(spawn).not.toHaveBeenCalled();
	});

	it("relays jj's stderr when the rev does not resolve", async () => {
		const exec = mockExec({
			"jj diff -r nosuchrev": {
				code: 1,
				stdout: "",
				stderr: 'Error: Revision "nosuchrev" doesn\'t exist',
			},
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const result = await stampRev(revInput("nosuchrev"), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toEqual({ ok: false, reason: "failed" });
		const errors = statuses.filter((s) => s.kind === "error");
		expect(errors.some((e) => e.code === "diff_fetch_failed")).toBe(true);
		expect(
			errors.some((e) =>
				e.message.includes('Revision "nosuchrev" doesn\'t exist'),
			),
		).toBe(true);
		// No mutation followed.
		expect(findDescribeBody(exec)).toBeUndefined();
	});

	it("returns failed when the diff fetch rejects", async () => {
		const exec = mockExec();
		(
			exec as unknown as { mockRejectedValueOnce: (v: unknown) => void }
		).mockRejectedValueOnce(new Error("exec adapter down"));
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const result = await stampRev(revInput("@"), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toEqual({ ok: false, reason: "failed" });
		expect(
			statuses.some(
				(s) => s.kind === "error" && s.code === "diff_fetch_failed",
			),
		).toBe(true);
	});

	it("relays jj's stderr and returns failed when describe fails", async () => {
		const exec = mockExec({
			"jj diff -r abc123": {
				code: 0,
				stdout: diffContent,
				stderr: "",
			},
			"jj describe": {
				code: 1,
				stdout: "",
				stderr: "Error: The change is immutable",
			},
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const result = await stampRev(revInput("abc123"), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toEqual({ ok: false, reason: "failed" });
		const errors = statuses.filter((s) => s.kind === "error");
		expect(errors.some((e) => e.code === "describe_failed")).toBe(true);
		expect(
			errors.some((e) => e.message.includes("The change is immutable")),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: stampSession provenance (both layer-2 contexts)
// ---------------------------------------------------------------------------

describe("stampSession provenance", () => {
	it("records the interaction source, session key, model, and versions", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		await stampSession(
			interactionInput({
				prompt: "Provenance check",
				response: "Done.",
				toolNames: ["write"],
				toolCallCount: 1,
				elapsedMs: 1000,
			}),
			{
				jj: createJj(exec),
				run: spawn,
				config: defaultConfig(),
				env: TEST_ENV,
				onStatus: sink,
			},
		);

		const body = findDescribeBody(exec);
		expect(body).toContain("source: interaction");
		expect(body).toContain("sillajje/test-session");
		expect(body).toContain("model: openai/gpt-4o-mini");
		expect(body).toContain("pi: test-pi");
		expect(body).toContain("sillajje: test-sillajje");
		// No fallbacks fired — the fallback field is absent.
		expect(body).not.toContain("fallback:");
	});

	it("records the fired fallbacks in the interaction provenance", async () => {
		const exec = mockExec();
		const spawn = vi.fn().mockRejectedValue(new Error("unavailable"));
		const { sink } = collectingSink();

		await stampSession(
			interactionInput({
				prompt: "Fallback provenance",
				response: "Done.",
			}),
			{
				jj: createJj(exec),
				run: spawn,
				config: defaultConfig(),
				env: TEST_ENV,
				onStatus: sink,
			},
		);

		const body = findDescribeBody(exec);
		expect(body).toContain("fallback: header,trace");
	});

	it("hides the Loop fields when the Loop section is not in the body", async () => {
		const exec = mockExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const cfg = defaultConfig({
			actions: {
				stamp: { body: ["trace", "meta", "prompt", "response"] },
			},
		});

		await stampSession(
			interactionInput({
				prompt: "Hidden provenance",
				response: "Done.",
			}),
			{
				jj: createJj(exec),
				run: spawn,
				config: cfg,
				env: TEST_ENV,
				onStatus: sink,
			},
		);

		const body = findDescribeBody(exec);
		expect(body).toContain("source: interaction");
		expect(body).toContain("pi: test-pi");
		expect(body).not.toContain("Loop:");
	});
});

// ---------------------------------------------------------------------------
// Tests: seal transaction (deferred integration)
// ---------------------------------------------------------------------------

describe("seal transaction", () => {
	const DEFERRED = ["--ignore-working-copy", "--no-integrate-operation"];
	const diffContent = "diff --git a/file b/file\n+added line\n";

	/** The seal tests' mock: non-empty working-copy diff, deferred ops mint ids. */
	function sealExec(overrides?: Record<string, ExecResult | Error>): ExecFn {
		return mockExec({
			"jj diff -r @": { code: 0, stdout: diffContent, stderr: "" },
			...overrides,
		});
	}

	it("chains describe → bookmark → new through deferred ops and integrates exactly once", async () => {
		const exec = sealExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toEqual({
			ok: true,
			subject: "act/feat: test interaction",
			rev: "@",
		});

		const calls = mockCalls(exec);

		// Exact argument sequences. The mock's deferred counter makes the
		// op ids deterministic: describe mints ...01, bookmark ...02, new ...03.
		expect(calls).toEqual(
			expect.arrayContaining([
				[
					"jj",
					["workspace", "update-stale", "--color=never"],
					expect.anything(),
				],
				[
					"jj",
					[
						"op",
						"log",
						"-n",
						"1",
						"--no-graph",
						"-T",
						"id",
						"--color=never",
					],
					expect.anything(),
				],
				[
					"jj",
					[
						"describe",
						"-r",
						"@",
						"-m",
						expect.stringContaining("act/feat: test interaction"),
						"--at-op",
						HEAD_OP_ID,
						...DEFERRED,
						"--color=never",
					],
					expect.anything(),
				],
				[
					"jj",
					[
						"bookmark",
						"set",
						"sillajje/test-session",
						"-r",
						"@",
						"--at-op",
						mockOpId(1),
						...DEFERRED,
						"--color=never",
					],
					expect.anything(),
				],
				[
					"jj",
					[
						"new",
						"--at-op",
						mockOpId(2),
						...DEFERRED,
						"--color=never",
					],
					expect.anything(),
				],
				[
					"jj",
					["op", "integrate", mockOpId(3), "--color=never"],
					expect.anything(),
				],
			]),
		);

		// Exactly one integrate.
		expect(
			calls.filter(
				(c) =>
					c[0] === "jj" &&
					c[1][0] === "op" &&
					c[1][1] === "integrate",
			),
		).toHaveLength(1);
	});

	it("parses the op id from jj 0.44's printed line format", async () => {
		// The mock's deferred line is captured verbatim from jj 0.44; this
		// test pins that the parser reads the id from that exact shape and
		// chains the next step on it.
		const exec = sealExec();
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		const calls = mockCalls(exec);
		const bmCall = calls.find(
			(c) => c[0] === "jj" && c[1][0] === "bookmark",
		);
		// The bookmark's --at-op is the id jj printed for the describe step.
		expect(bmCall?.[1]).toContain(mockOpId(1));
		const newCall = calls.find((c) => c[0] === "jj" && c[1][0] === "new");
		expect(newCall?.[1]).toContain(mockOpId(2));
	});

	it.each([
		[
			"describe fails",
			{ "jj describe": { code: 1, stdout: "", stderr: "describe boom" } },
			"describe_failed",
			0, // nothing dangling — nothing to abandon
		],
		[
			"bookmark set fails",
			{
				"jj bookmark set": {
					code: 1,
					stdout: "",
					stderr: "bookmark boom",
				},
			},
			"bookmark_set_failed",
			1, // the describe op is dangling
		],
		[
			"jj new fails",
			{ "jj new": { code: 1, stdout: "", stderr: "new boom" } },
			"jj_new_failed",
			1, // describe + bookmark dangling; abandon the first
		],
	])(
		"never integrates when the %s; abandons the dangling chain",
		async (_label, overrides, errorCode, expectedAbandons) => {
			const exec = sealExec(
				overrides as Record<string, ExecResult | Error>,
			);
			const spawn = mockSpawn();
			const { sink, statuses } = collectingSink();

			const result = await stampSession(diffInput(), {
				jj: createJj(exec),
				run: spawn,
				config: defaultConfig(),
				env: TEST_ENV,
				onStatus: sink,
			});

			expect(result).toEqual({ ok: false, reason: "failed" });

			const calls = mockCalls(exec);
			// The failure status names the step.
			expect(
				statuses.some(
					(s) => s.kind === "error" && s.code === errorCode,
				),
			).toBe(true);
			expect(
				statuses.some(
					(s) =>
						s.kind === "error" &&
						s.code === errorCode &&
						s.message.includes("boom"),
				),
			).toBe(true);

			// No integrate — the seal never became visible.
			expect(
				calls.some(
					(c) =>
						c[0] === "jj" &&
						c[1][0] === "op" &&
						c[1][1] === "integrate",
				),
			).toBe(false);

			// Best-effort abandon of the dangling chain, starting at its
			// first op.
			const abandons = calls.filter(
				(c) =>
					c[0] === "jj" && c[1][0] === "op" && c[1][1] === "abandon",
			);
			expect(abandons).toHaveLength(expectedAbandons);
			if (expectedAbandons > 0) {
				expect(abandons[0]![1]).toEqual([
					"op",
					"abandon",
					mockOpId(1),
					"--color=never",
				]);
			}
		},
	);

	it("does not abandon when a no-op describe leaves nothing dangling", async () => {
		// The re-describe changes nothing, so no operation is minted. The
		// failed bookmark must not abandon the integrated head the chain
		// chained on.
		const exec = sealExec({
			"jj describe": {
				code: 0,
				stdout: "",
				stderr: "Nothing changed.\n",
			},
			"jj bookmark set": {
				code: 1,
				stdout: "",
				stderr: "bookmark boom",
			},
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toEqual({ ok: false, reason: "failed" });
		expect(
			statuses.some(
				(s) => s.kind === "error" && s.code === "bookmark_set_failed",
			),
		).toBe(true);

		const calls = mockCalls(exec);
		const abandons = calls.filter(
			(c) => c[0] === "jj" && c[1][0] === "op" && c[1][1] === "abandon",
		);
		expect(abandons).toHaveLength(0);
	});

	it("abandons the first minted op when a later step fails after a no-op describe", async () => {
		// describe mints nothing; bookmark mints ...01; jj new fails. The
		// first dangling op is the bookmark's, not the integrated head.
		const exec = sealExec({
			"jj describe": {
				code: 0,
				stdout: "",
				stderr: "Nothing changed.\n",
			},
			"jj new": { code: 1, stdout: "", stderr: "new boom" },
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toEqual({ ok: false, reason: "failed" });
		expect(
			statuses.some(
				(s) => s.kind === "error" && s.code === "jj_new_failed",
			),
		).toBe(true);

		const calls = mockCalls(exec);
		const abandons = calls.filter(
			(c) => c[0] === "jj" && c[1][0] === "op" && c[1][1] === "abandon",
		);
		expect(abandons).toHaveLength(1);
		expect(abandons[0]![1]).toEqual([
			"op",
			"abandon",
			mockOpId(1),
			"--color=never",
		]);
	});

	it("abandons the chain when a later step's operation id is unparseable", async () => {
		// describe mints ...01; the bookmark step succeeds but prints no op
		// id, so the runner cannot chain on it. The describe op is still
		// dangling and must be abandoned.
		const exec = sealExec({
			"jj bookmark set": {
				code: 0,
				stdout: "unexpected output\n",
				stderr: "",
			},
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toEqual({ ok: false, reason: "failed" });
		expect(
			statuses.some(
				(s) =>
					s.kind === "error" &&
					s.code === "bookmark_set_failed" &&
					s.message.includes("could not parse"),
			),
		).toBe(true);

		const calls = mockCalls(exec);
		const abandons = calls.filter(
			(c) => c[0] === "jj" && c[1][0] === "op" && c[1][1] === "abandon",
		);
		expect(abandons).toHaveLength(1);
		expect(abandons[0]![1]).toEqual([
			"op",
			"abandon",
			mockOpId(1),
			"--color=never",
		]);
	});

	it("chains from the previous op id when a step is a no-op ('Nothing changed.')", async () => {
		// The session bookmark already points at @ — jj mints no operation.
		const exec = sealExec({
			"jj bookmark set": {
				code: 0,
				stdout: "",
				stderr: "Nothing changed.\n",
			},
		});
		const spawn = mockSpawn();
		const { sink } = collectingSink();

		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toEqual({
			ok: true,
			subject: "act/feat: test interaction",
			rev: "@",
		});

		const calls = mockCalls(exec);
		// `jj new` chains on the describe op (the bookmark minted nothing).
		const newCall = calls.find((c) => c[0] === "jj" && c[1][0] === "new");
		expect(newCall?.[1]).toContain("--at-op");
		expect(newCall?.[1]).toContain(mockOpId(1));
		// The seal still integrates exactly once, on the new op.
		expect(
			calls.some(
				(c) =>
					c[0] === "jj" &&
					c[1].join(" ") ===
						`op integrate ${mockOpId(2)} --color=never`,
			),
		).toBe(true);
	});

	it("treats a failed abandon as a non-fatal warning", async () => {
		const exec = sealExec({
			"jj bookmark set": { code: 1, stdout: "", stderr: "bookmark boom" },
			"jj op abandon": { code: 1, stdout: "", stderr: "abandon boom" },
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		// The stamp still reports failure — the abandon only cleans up.
		expect(result).toEqual({ ok: false, reason: "failed" });
		expect(
			statuses.some(
				(s) => s.kind === "warning" && s.code === "abandon_failed",
			),
		).toBe(true);
	});

	it("reports an integrate failure with the operation id and keeps the chain for manual recovery", async () => {
		const exec = sealExec({
			"jj op integrate": {
				code: 1,
				stdout: "",
				stderr: "integrate boom",
			},
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result).toEqual({ ok: false, reason: "failed" });
		const errors = statuses.filter((s) => s.kind === "error");
		expect(errors.some((e) => e.code === "integrate_failed")).toBe(true);
		// The error carries the op id — the documented manual fix.
		expect(
			errors.some(
				(e) =>
					e.message.includes(mockOpId(3)) &&
					e.message.includes("jj op integrate"),
			),
		).toBe(true);
		// The dangling chain is NOT abandoned — it is the manual recovery.
		const calls = mockCalls(exec);
		expect(
			calls.some(
				(c) =>
					c[0] === "jj" && c[1][0] === "op" && c[1][1] === "abandon",
			),
		).toBe(false);
	});

	it("runs header generation before the transaction opens", async () => {
		const events: [string, string][] = [];
		const exec = sealExec();
		(exec as ReturnType<typeof vi.fn>).mockImplementation(
			(cmd: string, args: string[], _opts?: { cwd?: string }) => {
				events.push(["exec", [cmd, ...args].join(" ")]);
				const key = [
					cmd,
					...args.filter((a) => a !== "--color=never"),
				].join(" ");
				if (key === "jj diff -r @") {
					return Promise.resolve({
						code: 0,
						stdout: "diff --git a/file b/file\n+added line\n",
						stderr: "",
					});
				}
				if (key === "jj op log -n 1 --no-graph -T id") {
					return Promise.resolve({
						code: 0,
						stdout: `${HEAD_OP_ID}\n`,
						stderr: "",
					});
				}
				if (args.includes("--no-integrate-operation")) {
					return Promise.resolve({
						code: 0,
						stdout: `${deferredOpLine(1)}\n`,
						stderr: "",
					});
				}
				return Promise.resolve({ code: 0, stdout: "", stderr: "" });
			},
		);
		const spawn = vi.fn().mockImplementation(() => {
			events.push(["spawn", ""]);
			return Promise.resolve({
				text: "act/feat: test interaction\n(some extra output)",
			});
		});
		const { sink } = collectingSink();

		await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		const spawnIndex = events.findIndex((e) => e[0] === "spawn");
		const firstDeferredIndex = events.findIndex((e) =>
			e[1].includes("--at-op"),
		);
		expect(spawnIndex).toBeGreaterThanOrEqual(0);
		expect(spawnIndex).toBeLessThan(firstDeferredIndex);
	});

	// ---------------------------------------------------------------
	// Divergence aftermath (ADR 0004: report, never auto-repair)
	// ---------------------------------------------------------------

	it("reports divergent variants of the stamped change after integrate", async () => {
		const exec = sealExec({
			"jj log -r @-": {
				code: 0,
				stdout: '{"commit_id":"1111111111111111111111111111111111111111","parents":[],"change_id":"qmvzrsyt","description":""}\n',
				stderr: "",
			},
			"jj log -r divergent()": {
				code: 0,
				stdout: [
					JSON.stringify({
						commit_id: "2".repeat(40),
						parents: [],
						change_id: "qmvzrsyt",
						description: "",
					}),
					JSON.stringify({
						commit_id: "3".repeat(40),
						parents: [],
						change_id: "zzrkspww",
						description: "",
					}),
					"",
				].join("\n"),
				stderr: "",
			},
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		// The seal itself succeeded — the report is a warning on top.
		expect(result).toEqual({
			ok: true,
			subject: "act/feat: test interaction",
			rev: "@",
		});
		expect(statuses).toContainEqual({
			kind: "warning",
			code: "divergence-after-integrate",
			message: expect.stringContaining("qmvzrsyt"),
		});
	});

	it("does not warn when the stamped change has no divergent variants", async () => {
		const exec = sealExec({
			"jj log -r @-": {
				code: 0,
				stdout: '{"commit_id":"1111111111111111111111111111111111111111","parents":[],"change_id":"qmvzrsyt","description":""}\n',
				stderr: "",
			},
			"jj log -r divergent()": {
				code: 0,
				stdout: '{"commit_id":"2222222222222222222222222222222222222222","parents":[],"change_id":"zzrkspww","description":""}\n',
				stderr: "",
			},
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		expect(result.ok).toBe(true);
		expect(statuses).not.toContainEqual(
			expect.objectContaining({ code: "divergence-after-integrate" }),
		);
	});

	it("skips the divergence probe silently when the probe fails", async () => {
		const exec = sealExec({
			"jj log -r @-": {
				code: 1,
				stdout: "",
				stderr: "boom",
			},
		});
		const spawn = mockSpawn();
		const { sink, statuses } = collectingSink();

		const result = await stampSession(diffInput(), {
			jj: createJj(exec),
			run: spawn,
			config: defaultConfig(),
			env: TEST_ENV,
			onStatus: sink,
		});

		// The committed seal must never be masked by a reporting failure.
		expect(result.ok).toBe(true);
		expect(statuses).not.toContainEqual(
			expect.objectContaining({ code: "divergence-after-integrate" }),
		);
	});
});
