import { describe, expect, it, vi } from "vitest";
import {
	generateHeader,
	generateManualHeader,
	generateTrace,
	type HeaderOptions,
	type RunSubagent,
	type SubagentResponse,
	type SubGeneratorContext,
	type TraceOptions,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(text: string): SubagentResponse {
	return { text };
}

/** A failed run: the subagent port rejects. */
function fail(message = "error"): Promise<never> {
	return Promise.reject(new Error(message));
}

const MINIMAL_CTX: SubGeneratorContext = {
	transcript: "User: hello\nAssistant: I did something",
	diff: "",
	previousDescriptions: [],
};

const FAKE_CTX: SubGeneratorContext = {
	transcript:
		"User: Add a login page\nAssistant: I created login.ts with form validation.",
	diff: "diff --git a/login.ts b/login.ts\n+export default function Login() { return <form>...</form> }",
	previousDescriptions: ["feat: add dashboard", "fix: handle null pointer"],
};

const DEFAULT_HEADER_OPTS: HeaderOptions = {
	model: "openai/gpt-4o-mini",
	maxAttempts: 3,
	timeoutMs: 30_000,
	prompt: "Add a login page",
};

const DEFAULT_TRACE_OPTS: TraceOptions = {
	model: "openai/gpt-4o-mini",
	maxAttempts: 3,
	timeoutMs: 30_000,
	detail: "high",
};

// ---------------------------------------------------------------------------
// generateHeader
// ---------------------------------------------------------------------------

describe("generateHeader", () => {
	it("spawns pi and returns first line as subject", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValue(ok("debug/fix: null pointer in auth"));

		const result = await generateHeader(FAKE_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			model: "claude-sonnet",
		});

		expect(result.text).toBe("debug/fix: null pointer in auth");

		expect(spawnFn).toHaveBeenCalledTimes(1);
		const [request] = spawnFn.mock.calls[0]!;
		expect(request.timeoutMs).toBe(30_000);
		expect(request.prompt).toContain("User: Add a login page");
		expect(request.prompt).toContain("feat: add dashboard");
		expect(request.prompt).toContain("login.ts");
	});

	it("extracts first line from multi-line output", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValue(
				ok(
					"debug/fix: null pointer in auth\nSome extra text that should be discarded\nAnd another line",
				),
			);

		const result = await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			prompt: "test",
		});

		expect(result.text).toBe("debug/fix: null pointer in auth");
	});

	it("uses full output when only one line", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValue(ok("answer: explained middleware"));

		const result = await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			prompt: "test",
		});

		expect(result.text).toBe("answer: explained middleware");
	});

	it("renders template variables into stdin input", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValue(ok("explore: audit code"));

		const ctx = {
			transcript: "User: show me the routes",
			diff: "diff --git a/routes.ts",
			previousDescriptions: ["prev1"],
		};

		await generateHeader(ctx, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			prompt: "test",
		});

		const [request] = spawnFn.mock.calls[0]!;
		expect(request.prompt).toContain("User: show me the routes");
		expect(request.prompt).toContain("diff --git a/routes.ts");
		expect(request.prompt).toContain("prev1");
		expect(request.prompt).toContain("Interaction types");
	});

	it("retries on empty output, then falls back to deriveSubject", async () => {
		const spawnFn = vi.fn<RunSubagent>().mockResolvedValue(ok("  \n  ")); // whitespace-only after trim

		const result = await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			prompt: "Fix the null pointer bug",
		});

		// After 3 attempts with empty output, falls back to deriveSubject
		expect(result.text).toBe("Fix the null pointer bug");
		expect(result.fellBack).toBe(true);
		expect(spawnFn).toHaveBeenCalledTimes(3);
	});

	it("retries on non-zero exit code, then falls back", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockReturnValue(fail("model overloaded"));

		const result = await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			maxAttempts: 2,
			prompt: "Refactor the API",
		});

		expect(result.text).toBe("Refactor the API");
		expect(result.fellBack).toBe(true);
		expect(spawnFn).toHaveBeenCalledTimes(2);
	});

	it("retries on throw (timeout), then falls back", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockRejectedValue(new Error("timeout: 30000ms"));

		const result = await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			maxAttempts: 3,
			prompt: "timeout test",
		});

		expect(result.text).toBe("timeout test");
		expect(result.fellBack).toBe(true);
		expect(spawnFn).toHaveBeenCalledTimes(3);
	});

	it("succeeds on second attempt after first failure", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockReturnValueOnce(fail("transient error"))
			.mockResolvedValueOnce(ok("act/fix: handle edge case"));

		const result = await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			prompt: "test",
		});

		expect(result.text).toBe("act/fix: handle edge case");
		expect(result.fellBack).toBe(false);
		expect(spawnFn).toHaveBeenCalledTimes(2);
	});

	it("does not retry on first success", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValue(ok("act/feat: add login"));

		const result = await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			prompt: "test",
		});

		expect(result.text).toBe("act/feat: add login");
		expect(result.fellBack).toBe(false);
		expect(spawnFn).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// generateManualHeader
// ---------------------------------------------------------------------------

describe("generateManualHeader", () => {
	it("spawns pi and returns conventional commit subject", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValue(ok("feat: add user login form"));

		const result = await generateManualHeader(
			"diff --git a/login.ts b/login.ts\n+export default function Login()",
			spawnFn,
			{ model: "openai/gpt-4o-mini", maxAttempts: 3, timeoutMs: 30_000 },
		);

		expect(result.text).toBe("feat: add user login form");

		expect(spawnFn).toHaveBeenCalledTimes(1);
		const [request] = spawnFn.mock.calls[0]!;
		expect(request.timeoutMs).toBe(30_000);
		expect(request.prompt).toContain("login.ts");
		expect(request.prompt).toContain("conventional commit");
		expect(request.prompt).toContain("Types: feat, fix");
		expect(request.prompt).not.toContain("Interaction types");
		expect(request.prompt).not.toContain("dual-prefix");
	});

	it("extracts first line from multi-line output", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValue(
				ok("fix: handle null pointer\nSome extra output\nAnd more"),
			);

		const result = await generateManualHeader(
			"diff --git a/auth.ts",
			spawnFn,
			{ model: "x", maxAttempts: 3, timeoutMs: 1000 },
		);

		expect(result.text).toBe("fix: handle null pointer");
	});

	it("uses full output when only one line", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValue(ok("refactor: extract validation"));

		const result = await generateManualHeader(
			"diff --git a/validate.ts",
			spawnFn,
			{ model: "x", maxAttempts: 3, timeoutMs: 1000 },
		);

		expect(result.text).toBe("refactor: extract validation");
	});

	it("renders diff into stdin input", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValue(ok("feat: add dashboard"));

		await generateManualHeader(
			"diff --git a/dashboard.tsx b/dashboard.tsx\n+export default function Dashboard()",
			spawnFn,
			{ model: "x", maxAttempts: 3, timeoutMs: 1000 },
		);

		const [request] = spawnFn.mock.calls[0]!;
		expect(request.prompt).toContain("dashboard.tsx");
		expect(request.prompt).toContain("conventional commit");
		expect(request.prompt).not.toContain("Interaction types");
		expect(request.prompt).not.toContain("dual-prefix");
	});

	it("retries on empty output, then falls back to chore: manual checkpoint", async () => {
		const spawnFn = vi.fn<RunSubagent>().mockResolvedValue(ok("   "));

		const result = await generateManualHeader(
			"diff --git a/x.ts",
			spawnFn,
			{ model: "x", maxAttempts: 2, timeoutMs: 1000 },
		);

		expect(result.text).toBe("chore: manual checkpoint");
		expect(result.fellBack).toBe(true);
		expect(spawnFn).toHaveBeenCalledTimes(2);
	});

	it("retries on non-zero exit code, then falls back", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockReturnValue(fail("model error"));

		const result = await generateManualHeader(
			"diff --git a/y.ts",
			spawnFn,
			{ model: "x", maxAttempts: 3, timeoutMs: 1000 },
		);

		expect(result.text).toBe("chore: manual checkpoint");
		expect(result.fellBack).toBe(true);
		expect(spawnFn).toHaveBeenCalledTimes(3);
	});

	it("retries on throw (timeout), then falls back", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockRejectedValue(new Error("timeout: 30000ms"));

		const result = await generateManualHeader(
			"diff --git a/z.ts",
			spawnFn,
			{ model: "x", maxAttempts: 2, timeoutMs: 1000 },
		);

		expect(result.text).toBe("chore: manual checkpoint");
		expect(result.fellBack).toBe(true);
		expect(spawnFn).toHaveBeenCalledTimes(2);
	});

	it("succeeds on second attempt after first failure", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockReturnValueOnce(fail("transient"))
			.mockResolvedValueOnce(ok("docs: update readme"));

		const result = await generateManualHeader(
			"diff --git a/README.md",
			spawnFn,
			{ model: "x", maxAttempts: 3, timeoutMs: 1000 },
		);

		expect(result.text).toBe("docs: update readme");
		expect(result.fellBack).toBe(false);
		expect(spawnFn).toHaveBeenCalledTimes(2);
	});

	it("does not retry on first success", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValue(ok("chore: bump version"));

		const result = await generateManualHeader(
			"diff --git a/package.json",
			spawnFn,
			{ model: "x", maxAttempts: 3, timeoutMs: 1000 },
		);

		expect(result.text).toBe("chore: bump version");
		expect(result.fellBack).toBe(false);
		expect(spawnFn).toHaveBeenCalledTimes(1);
	});

	it("includes fallback text when diff is empty string", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValue(ok("docs: initial"));

		const result = await generateManualHeader("", spawnFn, {
			model: "x",
			maxAttempts: 3,
			timeoutMs: 1000,
		});

		expect(result.text).toBe("docs: initial");
		const [request] = spawnFn.mock.calls[0]!;
		expect(request.prompt).toContain("(no file changes)");
	});
});

// ---------------------------------------------------------------------------
// generateTrace
// ---------------------------------------------------------------------------

describe("generateTrace", () => {
	it("spawns pi and returns entire stdout", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValue(
				ok(
					"The agent identified a null pointer in the auth middleware. It read auth.ts to understand the flow, then added a null check before the user lookup. The fix was applied and tests pass.",
				),
			);

		const result = await generateTrace(FAKE_CTX, spawnFn, {
			...DEFAULT_TRACE_OPTS,
			model: "openai/gpt-4o-mini",
		});

		expect(result.text).toContain("null pointer");
		expect(result.text).toContain("auth middleware");
		expect(result.text).toContain("auth.ts");

		expect(spawnFn).toHaveBeenCalledTimes(1);
		const [request] = spawnFn.mock.calls[0]!;
		expect(request.model).toBe("openai/gpt-4o-mini");
	});

	it("uses high-level prompt by default", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValue(ok("The agent solved the problem."));

		await generateTrace(MINIMAL_CTX, spawnFn, DEFAULT_TRACE_OPTS);

		const [request] = spawnFn.mock.calls[0]!;
		expect(request.prompt).toContain(
			"2-4 sentence plain-English narrative",
		);
		expect(request.prompt).not.toContain("numbered steps");
		expect(request.prompt).not.toContain("key insights, discoveries");
	});

	it("uses step-level prompt when detail is step", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValue(ok("1. Read the file\n2. Fixed the bug"));

		await generateTrace(MINIMAL_CTX, spawnFn, {
			...DEFAULT_TRACE_OPTS,
			detail: "step",
		});

		const [request] = spawnFn.mock.calls[0]!;
		expect(request.prompt).toContain("numbered steps");
		expect(request.prompt).not.toContain("2-4 sentence");
	});

	it("uses decision-level prompt when detail is decision", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValue(
				ok(
					"The key insight was that the cache invalidation was too aggressive.",
				),
			);

		await generateTrace(MINIMAL_CTX, spawnFn, {
			...DEFAULT_TRACE_OPTS,
			detail: "decision",
		});

		const [request] = spawnFn.mock.calls[0]!;
		expect(request.prompt).toContain("key decisions");
		expect(request.prompt).not.toContain("2-4 sentence");
	});

	it("renders template variables into stdin", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValue(ok("Trace output."));

		const ctx = {
			transcript: "User: check the error logs",
			diff: "diff --git a/logs.ts",
			previousDescriptions: ["prev1"],
		};

		await generateTrace(ctx, spawnFn, DEFAULT_TRACE_OPTS);

		const [request] = spawnFn.mock.calls[0]!;
		expect(request.prompt).toContain("User: check the error logs");
		expect(request.prompt).toContain("diff --git a/logs.ts");
		expect(request.prompt).toContain("prev1");
	});

	it("retries on empty output, then returns empty string", async () => {
		const spawnFn = vi.fn<RunSubagent>().mockResolvedValue(ok("   "));

		const result = await generateTrace(MINIMAL_CTX, spawnFn, {
			...DEFAULT_TRACE_OPTS,
			maxAttempts: 3,
		});

		expect(result.text).toBe("");
		expect(result.fellBack).toBe(true);
		expect(spawnFn).toHaveBeenCalledTimes(3);
	});

	it("retries on non-zero exit code, then returns empty string", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockReturnValue(fail("model error"));

		const result = await generateTrace(MINIMAL_CTX, spawnFn, {
			...DEFAULT_TRACE_OPTS,
			maxAttempts: 2,
		});

		expect(result.text).toBe("");
		expect(result.fellBack).toBe(true);
		expect(spawnFn).toHaveBeenCalledTimes(2);
	});

	it("retries on throw, then returns empty string", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockRejectedValue(new Error("timeout"));

		const result = await generateTrace(MINIMAL_CTX, spawnFn, {
			...DEFAULT_TRACE_OPTS,
			maxAttempts: 2,
		});

		expect(result.text).toBe("");
		expect(result.fellBack).toBe(true);
		expect(spawnFn).toHaveBeenCalledTimes(2);
	});

	it("succeeds on second attempt after first empty output", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValueOnce(ok(""))
			.mockResolvedValueOnce(ok("Fixed the bug by adding a null check."));

		const result = await generateTrace(MINIMAL_CTX, spawnFn, {
			...DEFAULT_TRACE_OPTS,
			maxAttempts: 3,
		});

		expect(result.text).toBe("Fixed the bug by adding a null check.");
		expect(result.fellBack).toBe(false);
		expect(spawnFn).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// Retry behaviour — shared logic tested through both functions
// ---------------------------------------------------------------------------

describe("retry wrapper behaviour", () => {
	it("exhausts all attempts before falling back", async () => {
		const spawnFn = vi.fn<RunSubagent>().mockReturnValue(fail("nope"));

		await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			maxAttempts: 5,
			prompt: "prompt",
		});

		expect(spawnFn).toHaveBeenCalledTimes(5);
	});

	it("does not retry on success (header)", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValueOnce(ok("act: done"))
			.mockResolvedValueOnce(ok("should not be called"));

		const result = await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			maxAttempts: 3,
			prompt: "test",
		});

		expect(result.text).toBe("act: done");
		expect(result.fellBack).toBe(false);
		expect(spawnFn).toHaveBeenCalledTimes(1);
	});

	it("does not retry on success (trace)", async () => {
		const spawnFn = vi
			.fn<RunSubagent>()
			.mockResolvedValueOnce(ok("trace narrative here"));

		const result = await generateTrace(MINIMAL_CTX, spawnFn, {
			...DEFAULT_TRACE_OPTS,
			maxAttempts: 3,
		});

		expect(result.text).toBe("trace narrative here");
		expect(result.fellBack).toBe(false);
		expect(spawnFn).toHaveBeenCalledTimes(1);
	});
});
