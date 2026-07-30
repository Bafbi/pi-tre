import { describe, expect, it, vi } from "vitest";

import {
	generateHeader,
	generateManualHeader,
	generateTrace,
	type HeaderOptions,
	type SpawnFn,
	type SubGeneratorContext,
	type TraceOptions,
} from "../../src/sub-generator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(stdout: string): {
	code: number;
	stdout: string;
	stderr: string;
} {
	return { code: 0, stdout, stderr: "" };
}

function fail(stderr = "error"): {
	code: number;
	stdout: string;
	stderr: string;
} {
	return { code: 1, stdout: "", stderr };
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
	it("spawns pi -p --no-session --no-tools --model and returns first line as subject", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(ok("debug/fix: null pointer in auth"));

		const result = await generateHeader(FAKE_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			model: "claude-sonnet",
		});

		expect(result).toBe("debug/fix: null pointer in auth");

		expect(spawnFn).toHaveBeenCalledTimes(1);
		const [cmd, args, input, timeoutMs] = spawnFn.mock.calls[0];
		expect(cmd).toBe("pi");
		expect(args).toEqual([
			"-p",
			"--no-session",
			"--no-tools",
			"--model",
			"claude-sonnet",
		]);
		expect(timeoutMs).toBe(30_000);
		expect(input).toContain("User: Add a login page");
		expect(input).toContain("feat: add dashboard");
		expect(input).toContain("login.ts");
	});

	it("extracts first line from multi-line output", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(
				ok(
					"debug/fix: null pointer in auth\nSome extra text that should be discarded\nAnd another line",
				),
			);

		const result = await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			prompt: "test",
		});

		expect(result).toBe("debug/fix: null pointer in auth");
	});

	it("uses full output when only one line", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(ok("answer: explained middleware"));

		const result = await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			prompt: "test",
		});

		expect(result).toBe("answer: explained middleware");
	});

	it("renders template variables into stdin input", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
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

		const [, , input] = spawnFn.mock.calls[0];
		expect(input).toContain("User: show me the routes");
		expect(input).toContain("diff --git a/routes.ts");
		expect(input).toContain("prev1");
		expect(input).toContain("Interaction types");
	});

	it("retries on empty output, then falls back to deriveSubject", async () => {
		const spawnFn = vi.fn<SpawnFn>().mockResolvedValue(ok("  \n  ")); // whitespace-only after trim

		const result = await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			prompt: "Fix the null pointer bug",
		});

		// After 3 attempts with empty output, falls back to deriveSubject
		expect(result).toBe("Fix the null pointer bug");
		expect(spawnFn).toHaveBeenCalledTimes(3);
	});

	it("retries on non-zero exit code, then falls back", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(fail("model overloaded"));

		const result = await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			maxAttempts: 2,
			prompt: "Refactor the API",
		});

		expect(result).toBe("Refactor the API");
		expect(spawnFn).toHaveBeenCalledTimes(2);
	});

	it("retries on throw (timeout), then falls back", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockRejectedValue(new Error("timeout: 30000ms"));

		const result = await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			maxAttempts: 3,
			prompt: "timeout test",
		});

		expect(result).toBe("timeout test");
		expect(spawnFn).toHaveBeenCalledTimes(3);
	});

	it("succeeds on second attempt after first failure", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValueOnce(fail("transient error"))
			.mockResolvedValueOnce(ok("act/fix: handle edge case"));

		const result = await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			prompt: "test",
		});

		expect(result).toBe("act/fix: handle edge case");
		expect(spawnFn).toHaveBeenCalledTimes(2);
	});

	it("does not retry on first success", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(ok("act/feat: add login"));

		const result = await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			prompt: "test",
		});

		expect(result).toBe("act/feat: add login");
		expect(spawnFn).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// generateManualHeader
// ---------------------------------------------------------------------------

describe("generateManualHeader", () => {
	it("spawns pi -p --no-session --no-tools --model and returns subject", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(ok("feat: add user login form"));

		const result = await generateManualHeader(
			"diff --git a/login.ts b/login.ts\n+export default function Login()",
			spawnFn,
			{ model: "openai/gpt-4o-mini", maxAttempts: 3, timeoutMs: 30_000 },
		);

		expect(result).toBe("feat: add user login form");

		expect(spawnFn).toHaveBeenCalledTimes(1);
		const [cmd, args, input, timeoutMs] = spawnFn.mock.calls[0];
		expect(cmd).toBe("pi");
		expect(args).toEqual([
			"-p",
			"--no-session",
			"--no-tools",
			"--model",
			"openai/gpt-4o-mini",
		]);
		expect(timeoutMs).toBe(30_000);
		expect(input).toContain("login.ts");
		expect(input).toContain("conventional commit");
		expect(input).toContain("Types: feat, fix");
		expect(input).not.toContain("Interaction types");
		expect(input).not.toContain("dual-prefix");
	});

	it("extracts first line from multi-line output", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(
				ok("fix: handle null pointer\nSome extra output\nAnd more"),
			);

		const result = await generateManualHeader(
			"diff --git a/auth.ts",
			spawnFn,
			{ model: "x", maxAttempts: 3, timeoutMs: 1000 },
		);

		expect(result).toBe("fix: handle null pointer");
	});

	it("uses full output when only one line", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(ok("refactor: extract validation"));

		const result = await generateManualHeader(
			"diff --git a/validate.ts",
			spawnFn,
			{ model: "x", maxAttempts: 3, timeoutMs: 1000 },
		);

		expect(result).toBe("refactor: extract validation");
	});

	it("renders diff into stdin input", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(ok("feat: add dashboard"));

		await generateManualHeader(
			"diff --git a/dashboard.tsx b/dashboard.tsx\n+export default function Dashboard()",
			spawnFn,
			{ model: "x", maxAttempts: 3, timeoutMs: 1000 },
		);

		const [, , input] = spawnFn.mock.calls[0];
		expect(input).toContain("dashboard.tsx");
		expect(input).toContain("conventional commit");
		expect(input).not.toContain("Interaction types");
		expect(input).not.toContain("dual-prefix");
	});

	it("retries on empty output, then falls back to chore: manual checkpoint", async () => {
		const spawnFn = vi.fn<SpawnFn>().mockResolvedValue(ok("   "));

		const result = await generateManualHeader(
			"diff --git a/x.ts",
			spawnFn,
			{ model: "x", maxAttempts: 2, timeoutMs: 1000 },
		);

		expect(result).toBe("chore: manual checkpoint");
		expect(spawnFn).toHaveBeenCalledTimes(2);
	});

	it("retries on non-zero exit code, then falls back", async () => {
		const spawnFn = vi.fn<SpawnFn>().mockResolvedValue(fail("model error"));

		const result = await generateManualHeader(
			"diff --git a/y.ts",
			spawnFn,
			{ model: "x", maxAttempts: 3, timeoutMs: 1000 },
		);

		expect(result).toBe("chore: manual checkpoint");
		expect(spawnFn).toHaveBeenCalledTimes(3);
	});

	it("retries on throw (timeout), then falls back", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockRejectedValue(new Error("timeout: 30000ms"));

		const result = await generateManualHeader(
			"diff --git a/z.ts",
			spawnFn,
			{ model: "x", maxAttempts: 2, timeoutMs: 1000 },
		);

		expect(result).toBe("chore: manual checkpoint");
		expect(spawnFn).toHaveBeenCalledTimes(2);
	});

	it("succeeds on second attempt after first failure", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValueOnce(fail("transient"))
			.mockResolvedValueOnce(ok("docs: update readme"));

		const result = await generateManualHeader(
			"diff --git a/README.md",
			spawnFn,
			{ model: "x", maxAttempts: 3, timeoutMs: 1000 },
		);

		expect(result).toBe("docs: update readme");
		expect(spawnFn).toHaveBeenCalledTimes(2);
	});

	it("does not retry on first success", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(ok("chore: bump version"));

		const result = await generateManualHeader(
			"diff --git a/package.json",
			spawnFn,
			{ model: "x", maxAttempts: 3, timeoutMs: 1000 },
		);

		expect(result).toBe("chore: bump version");
		expect(spawnFn).toHaveBeenCalledTimes(1);
	});

	it("includes fallback text when diff is empty string", async () => {
		const spawnFn = vi.fn<SpawnFn>().mockResolvedValue(ok("docs: initial"));

		const result = await generateManualHeader("", spawnFn, {
			model: "x",
			maxAttempts: 3,
			timeoutMs: 1000,
		});

		expect(result).toBe("docs: initial");
		const [, , input] = spawnFn.mock.calls[0];
		expect(input).toContain("(no file changes)");
	});
});

// ---------------------------------------------------------------------------
// generateTrace
// ---------------------------------------------------------------------------

describe("generateTrace", () => {
	it("spawns pi -p --no-session --no-tools --model and returns entire stdout", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(
				ok(
					"The agent identified a null pointer in the auth middleware. It read auth.ts to understand the flow, then added a null check before the user lookup. The fix was applied and tests pass.",
				),
			);

		const result = await generateTrace(FAKE_CTX, spawnFn, {
			...DEFAULT_TRACE_OPTS,
			model: "openai/gpt-4o-mini",
		});

		expect(result).toContain("null pointer");
		expect(result).toContain("auth middleware");
		expect(result).toContain("auth.ts");

		expect(spawnFn).toHaveBeenCalledTimes(1);
		const [cmd, args] = spawnFn.mock.calls[0];
		expect(cmd).toBe("pi");
		expect(args).toEqual([
			"-p",
			"--no-session",
			"--no-tools",
			"--model",
			"openai/gpt-4o-mini",
		]);
	});

	it("uses high-level prompt by default", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(ok("The agent solved the problem."));

		await generateTrace(MINIMAL_CTX, spawnFn, DEFAULT_TRACE_OPTS);

		const [, , input] = spawnFn.mock.calls[0];
		expect(input).toContain("2-4 sentence plain-English narrative");
		expect(input).not.toContain("numbered steps");
		expect(input).not.toContain("key insights, discoveries");
	});

	it("uses step-level prompt when detail is step", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(ok("1. Read the file\n2. Fixed the bug"));

		await generateTrace(MINIMAL_CTX, spawnFn, {
			...DEFAULT_TRACE_OPTS,
			detail: "step",
		});

		const [, , input] = spawnFn.mock.calls[0];
		expect(input).toContain("numbered steps");
		expect(input).not.toContain("2-4 sentence");
	});

	it("uses decision-level prompt when detail is decision", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(
				ok(
					"The key insight was that the cache invalidation was too aggressive.",
				),
			);

		await generateTrace(MINIMAL_CTX, spawnFn, {
			...DEFAULT_TRACE_OPTS,
			detail: "decision",
		});

		const [, , input] = spawnFn.mock.calls[0];
		expect(input).toContain("key decisions");
		expect(input).not.toContain("2-4 sentence");
	});

	it("renders template variables into stdin", async () => {
		const spawnFn = vi.fn<SpawnFn>().mockResolvedValue(ok("Trace output."));

		const ctx = {
			transcript: "User: check the error logs",
			diff: "diff --git a/logs.ts",
			previousDescriptions: ["prev1"],
		};

		await generateTrace(ctx, spawnFn, DEFAULT_TRACE_OPTS);

		const [, , input] = spawnFn.mock.calls[0];
		expect(input).toContain("User: check the error logs");
		expect(input).toContain("diff --git a/logs.ts");
		expect(input).toContain("prev1");
	});

	it("retries on empty output, then returns empty string", async () => {
		const spawnFn = vi.fn<SpawnFn>().mockResolvedValue(ok("   "));

		const result = await generateTrace(MINIMAL_CTX, spawnFn, {
			...DEFAULT_TRACE_OPTS,
			maxAttempts: 3,
		});

		expect(result).toBe("");
		expect(spawnFn).toHaveBeenCalledTimes(3);
	});

	it("retries on non-zero exit code, then returns empty string", async () => {
		const spawnFn = vi.fn<SpawnFn>().mockResolvedValue(fail("model error"));

		const result = await generateTrace(MINIMAL_CTX, spawnFn, {
			...DEFAULT_TRACE_OPTS,
			maxAttempts: 2,
		});

		expect(result).toBe("");
		expect(spawnFn).toHaveBeenCalledTimes(2);
	});

	it("retries on throw, then returns empty string", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockRejectedValue(new Error("timeout"));

		const result = await generateTrace(MINIMAL_CTX, spawnFn, {
			...DEFAULT_TRACE_OPTS,
			maxAttempts: 2,
		});

		expect(result).toBe("");
		expect(spawnFn).toHaveBeenCalledTimes(2);
	});

	it("succeeds on second attempt after first empty output", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValueOnce(ok(""))
			.mockResolvedValueOnce(ok("Fixed the bug by adding a null check."));

		const result = await generateTrace(MINIMAL_CTX, spawnFn, {
			...DEFAULT_TRACE_OPTS,
			maxAttempts: 3,
		});

		expect(result).toBe("Fixed the bug by adding a null check.");
		expect(spawnFn).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// Retry behaviour — shared logic tested through both functions
// ---------------------------------------------------------------------------

describe("retry wrapper behaviour", () => {
	it("exhausts all attempts before falling back", async () => {
		const spawnFn = vi.fn<SpawnFn>().mockResolvedValue(fail("nope"));

		await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			maxAttempts: 5,
			prompt: "prompt",
		});

		expect(spawnFn).toHaveBeenCalledTimes(5);
	});

	it("does not retry on success (header)", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValueOnce(ok("act: done"))
			.mockResolvedValueOnce(ok("should not be called"));

		const result = await generateHeader(MINIMAL_CTX, spawnFn, {
			...DEFAULT_HEADER_OPTS,
			maxAttempts: 3,
			prompt: "test",
		});

		expect(result).toBe("act: done");
		expect(spawnFn).toHaveBeenCalledTimes(1);
	});

	it("does not retry on success (trace)", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValueOnce(ok("trace narrative here"));

		const result = await generateTrace(MINIMAL_CTX, spawnFn, {
			...DEFAULT_TRACE_OPTS,
			maxAttempts: 3,
		});

		expect(result).toBe("trace narrative here");
		expect(spawnFn).toHaveBeenCalledTimes(1);
	});
});
