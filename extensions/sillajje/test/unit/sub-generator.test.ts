import { describe, expect, it, vi } from "vitest";

import { generate, type SpawnFn } from "../../src/sub-generator";

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

const MINIMAL_CTX = {
	transcript: "User: hello\nAssistant: I did something",
	diff: "",
	previousDescriptions: [],
};

const FAKE_INTERACTION_CTX = {
	transcript:
		"User: Add a login page\nAssistant: I created login.ts with form validation.",
	diff: "diff --git a/login.ts b/login.ts\n+export default function Login() { return <form>...</form> }",
	previousDescriptions: ["feat: add dashboard", "fix: handle null pointer"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sub-generator generate", () => {
	it("spawns pi -p --no-session --model and returns parsed output", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(ok("feat: add login\nCreated the login page."));

		const result = await generate(
			FAKE_INTERACTION_CTX,
			spawnFn,
			"openai/gpt-4o-mini",
		);

		expect(result.subject).toBe("feat: add login");
		expect(result.summary).toBe("Created the login page.");

		expect(spawnFn).toHaveBeenCalledTimes(1);
		const [cmd, args, input, timeoutMs] = spawnFn.mock.calls[0];
		expect(cmd).toBe("pi");
		// Full args array — must match what pi -p actually accepts.
		// If a flag changes (e.g. -m vs --model), this test fails.
		expect(args).toEqual([
			"-p",
			"--no-session",
			"--model",
			"openai/gpt-4o-mini",
		]);
		expect(timeoutMs).toBeGreaterThan(0);
		expect(input).toContain("User: Add a login page");
		expect(input).toContain("feat: add dashboard");
		expect(input).toContain("login.ts");
	});

	it("parses subject from first line and summary from remaining lines", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(
				ok(
					"feat: add login page\n\nCreated the login page with form validation.\nAdded tests.",
				),
			);

		const result = await generate(MINIMAL_CTX, spawnFn);

		expect(result.subject).toBe("feat: add login page");
		expect(result.summary).toBe(
			"Created the login page with form validation.\nAdded tests.",
		);
	});

	it("handles single-line output (no summary)", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(ok("fix: handle null pointer"));

		const result = await generate(MINIMAL_CTX, spawnFn);

		expect(result.subject).toBe("fix: handle null pointer");
		expect(result.summary).toBe("");
	});

	it("renders template variables into stdin input", async () => {
		const spawnFn = vi.fn<SpawnFn>().mockResolvedValue(ok("docs: readme"));
		const ctx = {
			transcript: "test transcript",
			diff: "test diff",
			previousDescriptions: ["prev1", "prev2"],
		};

		await generate(ctx, spawnFn);

		const [, , input] = spawnFn.mock.calls[0];
		expect(input).toContain("test transcript");
		expect(input).toContain("test diff");
		expect(input).toContain("prev1");
		expect(input).toContain("prev2");
	});

	it("throws when spawnFn returns non-zero exit code", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockResolvedValue(fail("model not found"));

		await expect(generate(MINIMAL_CTX, spawnFn)).rejects.toThrow(
			"sub-generator failed",
		);
	});

	it("throws when spawnFn throws", async () => {
		const spawnFn = vi
			.fn<SpawnFn>()
			.mockRejectedValue(new Error("timeout"));

		await expect(generate(MINIMAL_CTX, spawnFn)).rejects.toThrow(
			"sub-generator failed",
		);
	});
});
