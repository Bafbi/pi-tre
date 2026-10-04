/**
 * Tests for Seed — copying ignored paths from the launching checkout into a
 * session Workspace, and moving edits with `/sillajje:seed`.
 *
 * One seam: the extension integration harness. Each test drives a real jj repo
 * through `session_start` or `/sillajje:seed`, and observes the files on disk,
 * the `sillajje/seed` record, and the notifications.
 */

import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { lastSeedRecord, SESSION_SEED_TYPE } from "../../src/seed.js";
import {
	createRunner,
	describeJj,
	getSessionId,
	getSessionManager,
	makeRunnerCwd,
	recordInteraction,
	runSillajje,
	tempDirs,
	wsPath,
} from "./_helpers.js";

/** Write the project sillajje config for a repo. */
function writeSillajjeConfig(cwd: string, config: Record<string, unknown>) {
	const dir = join(cwd, ".pi/configs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "sillajje.json"), JSON.stringify(config));
}

/**
 * A repo with `.gitignore` and `README.md` in the base tree, `main` as
 * `trunk()`, and a working copy at `@`. Returns the repo root.
 */
function initSeedRepo(): string {
	const cwd = makeRunnerCwd();
	tempDirs.push(cwd);
	execSync("jj git init --config signing.backend=none", {
		cwd,
		stdio: "pipe",
	});
	writeFileSync(join(cwd, ".gitignore"), ".env\n.local/\n");
	writeFileSync(join(cwd, "README.md"), "# Test\n");
	execSync("jj describe -m 'initial'", { cwd, stdio: "pipe" });
	execSync("jj bookmark set main -r @", { cwd, stdio: "pipe" });
	execSync(`jj config set --repo 'revset-aliases."trunk()"' main`, {
		cwd,
		stdio: "pipe",
	});
	execSync("jj new -m 'work'", { cwd, stdio: "pipe" });
	return cwd;
}

/**
 * Start a session seeded with `.env`, returning the repo, the Workspace, and
 * the UI notifications it emitted. Shared by the command describes.
 */
async function startSeeded(): Promise<{
	cwd: string;
	workspace: string;
	runner: Awaited<ReturnType<typeof createRunner>>;
	notifications: Array<{ msg: string; type: string }>;
}> {
	const cwd = initSeedRepo();
	writeFileSync(join(cwd, ".env"), "SECRET=1\n");
	writeSillajjeConfig(cwd, { seed: [".env"] });
	const notifications: Array<{ msg: string; type: string }> = [];
	const runner = await createRunner(cwd, {
		onNotify: (msg, type) => notifications.push({ msg, type }),
	});
	await runner.emit({ type: "session_start", reason: "startup" });
	const workspace = wsPath(cwd, getSessionId(runner));
	return { cwd, workspace, runner, notifications };
}

describeJj("sillajje seed — copy at workspace creation", () => {
	it("copies a seeded ignored file into the workspace and records it", async () => {
		const cwd = initSeedRepo();
		writeFileSync(join(cwd, ".env"), "SECRET=1\n");
		writeSillajjeConfig(cwd, { seed: [".env"] });

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);
		expect(readFileSync(join(workspace, ".env"), "utf-8")).toBe(
			"SECRET=1\n",
		);

		const record = lastSeedRecord(getSessionManager(runner).getBranch());
		expect(record).toBeDefined();
		expect(record?.source).toBe(cwd);
		expect(Object.keys(record?.paths ?? {})).toEqual([".env"]);
	});

	it("copies a seeded ignored directory recursively", async () => {
		const cwd = initSeedRepo();
		mkdirSync(join(cwd, ".local/nested"), { recursive: true });
		writeFileSync(join(cwd, ".local/a.txt"), "a\n");
		writeFileSync(join(cwd, ".local/nested/b.txt"), "b\n");
		writeSillajjeConfig(cwd, { seed: [".local"] });

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const workspace = wsPath(cwd, getSessionId(runner));
		expect(readFileSync(join(workspace, ".local/a.txt"), "utf-8")).toBe(
			"a\n",
		);
		expect(
			readFileSync(join(workspace, ".local/nested/b.txt"), "utf-8"),
		).toBe("b\n");

		const record = lastSeedRecord(getSessionManager(runner).getBranch());
		expect(Object.keys(record?.paths ?? {}).sort()).toEqual([
			".local/a.txt",
			".local/nested/b.txt",
		]);
	});

	it("does not overwrite a tracked path, and writes no record for one", async () => {
		const cwd = initSeedRepo();
		// Unlanded edit on the tracked file in the launching checkout.
		writeFileSync(join(cwd, "README.md"), "# Modified\n");
		writeSillajjeConfig(cwd, { seed: ["README.md"] });

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const workspace = wsPath(cwd, getSessionId(runner));
		expect(readFileSync(join(workspace, "README.md"), "utf-8")).toBe(
			"# Test\n",
		);
		expect(
			lastSeedRecord(getSessionManager(runner).getBranch()),
		).toBeUndefined();
	});

	it("reports a missing seed path and writes no record", async () => {
		const cwd = initSeedRepo();
		writeSillajjeConfig(cwd, { seed: ["nope.txt"] });

		const notifications: Array<{ msg: string; type: string }> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push({ msg, type }),
		});
		await runner.emit({ type: "session_start", reason: "startup" });

		expect(
			notifications.some(
				(n) => n.msg.includes("nope.txt") && n.type === "warning",
			),
		).toBe(true);
		expect(
			lastSeedRecord(getSessionManager(runner).getBranch()),
		).toBeUndefined();
	});

	it("does not re-copy on a reused workspace, so an edit survives", async () => {
		const cwd = initSeedRepo();
		writeFileSync(join(cwd, ".env"), "SECRET=1\n");
		writeSillajjeConfig(cwd, { seed: [".env"] });

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const workspace = wsPath(cwd, getSessionId(runner));
		writeFileSync(join(workspace, ".env"), "EDITED\n");
		// The checkout changes too; a re-copy would clobber the edit.
		writeFileSync(join(cwd, ".env"), "SECRET=2\n");

		await runner.emit({ type: "session_start", reason: "reload" });

		expect(readFileSync(join(workspace, ".env"), "utf-8")).toBe("EDITED\n");
	});

	it("keeps a seeded file invisible to jj", async () => {
		const cwd = initSeedRepo();
		writeFileSync(join(cwd, ".env"), "SECRET=1\n");
		writeSillajjeConfig(cwd, { seed: [".env"] });

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });

		const workspace = wsPath(cwd, getSessionId(runner));
		expect(
			execSync("jj status", { cwd: workspace, encoding: "utf-8" }),
		).not.toContain(".env");
		expect(
			execSync("jj diff --summary", {
				cwd: workspace,
				encoding: "utf-8",
			}),
		).not.toContain(".env");
	});
});

describeJj("sillajje seed — /sillajje:seed reports divergence", () => {
	it("lists a seeded path as unchanged, then workspace-moved, then checkout-moved", async () => {
		const { cwd, workspace, runner, notifications } = await startSeeded();

		await runSillajje(runner, "seed");
		expect(notifications.at(-1)?.msg).toContain(".env");
		expect(notifications.at(-1)?.msg).toContain("unchanged");

		writeFileSync(join(workspace, ".env"), "EDITED\n");
		await runSillajje(runner, "seed");
		expect(notifications.at(-1)?.msg).toContain("workspace");

		writeFileSync(join(workspace, ".env"), "SECRET=1\n");
		writeFileSync(join(cwd, ".env"), "SECRET=2\n");
		await runSillajje(runner, "seed");
		expect(notifications.at(-1)?.msg).toContain("checkout");
	});

	it("prints usage for -h", async () => {
		const { runner, notifications } = await startSeeded();
		await runSillajje(runner, "seed -h");
		expect(notifications.at(-1)?.msg).toContain("seed [-s|--session <id>]");
	});

	it("reports when no seed list is configured", async () => {
		const cwd = initSeedRepo();
		const notifications: Array<{ msg: string; type: string }> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push({ msg, type }),
		});
		await runner.emit({ type: "session_start", reason: "startup" });

		await runSillajje(runner, "seed");
		expect(notifications.at(-1)?.msg).toContain("no seed list");
	});

	it("reports when a seed list is configured but nothing was copied", async () => {
		const cwd = initSeedRepo();
		// `.env` is listed but absent from the checkout, so no record is written.
		writeSillajjeConfig(cwd, { seed: [".env"] });
		const notifications: Array<{ msg: string; type: string }> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push({ msg, type }),
		});
		await runner.emit({ type: "session_start", reason: "startup" });

		await runSillajje(runner, "seed");
		expect(notifications.at(-1)?.msg).toContain("no Seed record");
	});

	it("targets another session with -s <id>", async () => {
		const cwd = initSeedRepo();
		writeFileSync(join(cwd, ".env"), "SECRET=1\n");
		writeSillajjeConfig(cwd, { seed: [".env"] });

		const first = await createRunner(cwd);
		await first.emit({ type: "session_start", reason: "startup" });
		// A session log is not written to disk until its first assistant message,
		// so give the first session an interaction before reading it by id.
		recordInteraction(first, "hello", "hi");
		const firstId = getSessionId(first);

		const notifications: Array<{ msg: string; type: string }> = [];
		const second = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push({ msg, type }),
		});
		await second.emit({ type: "session_start", reason: "startup" });

		await runSillajje(second, `seed -s ${firstId}`);
		expect(notifications.at(-1)?.msg).toContain(".env");
		expect(notifications.at(-1)?.msg).toContain("unchanged");
	});
});

describeJj("sillajje seed — /sillajje:seed moves edits", () => {
	it("--push copies a workspace edit back to the checkout", async () => {
		const { cwd, workspace, runner, notifications } = await startSeeded();
		writeFileSync(join(workspace, ".env"), "EDITED\n");

		await runSillajje(runner, "seed --push");
		expect(readFileSync(join(cwd, ".env"), "utf-8")).toBe("EDITED\n");
		expect(notifications.at(-1)?.msg).toContain(".env");
	});

	it("--push refuses a path the checkout also moved, and --force overwrites", async () => {
		const { cwd, workspace, runner, notifications } = await startSeeded();
		writeFileSync(join(workspace, ".env"), "WORKSPACE\n");
		writeFileSync(join(cwd, ".env"), "CHECKOUT\n");

		await runSillajje(runner, "seed --push");
		expect(readFileSync(join(cwd, ".env"), "utf-8")).toBe("CHECKOUT\n");
		expect(notifications.at(-1)?.msg.toLowerCase()).toContain("refus");

		await runSillajje(runner, "seed --push --force");
		expect(readFileSync(join(cwd, ".env"), "utf-8")).toBe("WORKSPACE\n");
	});

	it("--pull refreshes the workspace and refuses a workspace edit", async () => {
		const { cwd, workspace, runner, notifications } = await startSeeded();
		writeFileSync(join(cwd, ".env"), "CHECKOUT\n");

		await runSillajje(runner, "seed --pull");
		expect(readFileSync(join(workspace, ".env"), "utf-8")).toBe(
			"CHECKOUT\n",
		);

		writeFileSync(join(cwd, ".env"), "CHECKOUT2\n");
		writeFileSync(join(workspace, ".env"), "WORKSPACE\n");
		await runSillajje(runner, "seed --pull");
		expect(readFileSync(join(workspace, ".env"), "utf-8")).toBe(
			"WORKSPACE\n",
		);
		expect(notifications.at(-1)?.msg.toLowerCase()).toContain("refus");

		await runSillajje(runner, "seed --pull --force");
		expect(readFileSync(join(workspace, ".env"), "utf-8")).toBe(
			"CHECKOUT2\n",
		);
	});

	it("reports a path missing on one side and never deletes the other", async () => {
		const { cwd, workspace, runner, notifications } = await startSeeded();
		rmSync(join(workspace, ".env"));

		await runSillajje(runner, "seed --push");
		expect(readFileSync(join(cwd, ".env"), "utf-8")).toBe("SECRET=1\n");
		expect(notifications.at(-1)?.msg).toContain(".env");
		expect(notifications.at(-1)?.msg).toContain("missing");
	});

	it("rejects --push with --pull, and --force alone", async () => {
		const { runner, notifications } = await startSeeded();
		await runSillajje(runner, "seed --push --pull");
		expect(notifications.at(-1)?.type).toBe("warning");
		await runSillajje(runner, "seed --force");
		expect(notifications.at(-1)?.type).toBe("warning");
	});

	it("rejects --force before looking for a record", async () => {
		const cwd = initSeedRepo();
		const notifications: Array<{ msg: string; type: string }> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push({ msg, type }),
		});
		await runner.emit({ type: "session_start", reason: "startup" });

		await runSillajje(runner, "seed --force");
		expect(notifications.at(-1)?.type).toBe("warning");
		expect(notifications.at(-1)?.msg).toContain("--force requires");
	});

	it("--pull --force restores a moved workspace file from an unchanged checkout", async () => {
		const { workspace, runner } = await startSeeded();
		writeFileSync(join(workspace, ".env"), "EDITED\n");

		await runSillajje(runner, "seed --pull");
		expect(readFileSync(join(workspace, ".env"), "utf-8")).toBe("EDITED\n");

		await runSillajje(runner, "seed --pull --force");
		expect(readFileSync(join(workspace, ".env"), "utf-8")).toBe(
			"SECRET=1\n",
		);
	});

	it("--push advances the baseline, so a second push is not a false conflict", async () => {
		const { cwd, workspace, runner } = await startSeeded();
		writeFileSync(join(workspace, ".env"), "W1\n");
		await runSillajje(runner, "seed --push");
		expect(readFileSync(join(cwd, ".env"), "utf-8")).toBe("W1\n");

		writeFileSync(join(workspace, ".env"), "W2\n");
		await runSillajje(runner, "seed --push");
		expect(readFileSync(join(cwd, ".env"), "utf-8")).toBe("W2\n");
	});

	it("pushes a foreign session's edit to its recorded source", async () => {
		const cwd = initSeedRepo();
		writeFileSync(join(cwd, ".env"), "SECRET=1\n");
		writeSillajjeConfig(cwd, { seed: [".env"] });

		const first = await createRunner(cwd);
		await first.emit({ type: "session_start", reason: "startup" });
		recordInteraction(first, "hello", "hi");
		const firstId = getSessionId(first);
		writeFileSync(join(wsPath(cwd, firstId), ".env"), "EDITED\n");

		const notifications: Array<{ msg: string; type: string }> = [];
		const second = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push({ msg, type }),
		});
		await second.emit({ type: "session_start", reason: "startup" });

		await runSillajje(second, `seed -s ${firstId} --push`);
		expect(readFileSync(join(cwd, ".env"), "utf-8")).toBe("EDITED\n");
		expect(notifications.at(-1)?.msg).toContain(".env");
	});
});

describeJj("sillajje seed — archive and unarchive", () => {
	it("warns about a diverged seed at archive and still deletes the workspace", async () => {
		const cwd = initSeedRepo();
		writeFileSync(join(cwd, ".env"), "SECRET=1\n");
		writeSillajjeConfig(cwd, { seed: [".env"] });
		const notifications: Array<{ msg: string; type: string }> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push({ msg, type }),
		});
		await runner.emit({ type: "session_start", reason: "startup" });
		const workspace = wsPath(cwd, getSessionId(runner));
		writeFileSync(join(workspace, ".env"), "EDITED\n");
		notifications.length = 0;

		await runSillajje(runner, "archive");

		expect(
			notifications.some(
				(n) => n.type === "warning" && n.msg.includes(".env"),
			),
		).toBe(true);
		expect(existsSync(workspace)).toBe(false);
	});

	it("re-seeds a restored workspace from the recorded source", async () => {
		const cwd = initSeedRepo();
		writeFileSync(join(cwd, ".env"), "SECRET=1\n");
		writeSillajjeConfig(cwd, { seed: [".env"] });
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const workspace = wsPath(cwd, getSessionId(runner));
		// The session bookmark is created on the first agent start; unarchive
		// rebuilds from it.
		await runner.emitBeforeAgentStart(
			"seed",
			undefined,
			"You are helpful.",
			{
				skills: [],
				contextFiles: [],
				cwd: "",
			},
		);

		await runSillajje(runner, "archive");
		expect(existsSync(workspace)).toBe(false);
		// Change the checkout so the re-copy is observable.
		writeFileSync(join(cwd, ".env"), "SECRET=2\n");

		await runSillajje(runner, "unarchive");
		expect(readFileSync(join(workspace, ".env"), "utf-8")).toBe(
			"SECRET=2\n",
		);
	});

	it("falls back to the current checkout when the recorded source is gone", async () => {
		const cwd = initSeedRepo();
		writeFileSync(join(cwd, ".env"), "SECRET=1\n");
		writeSillajjeConfig(cwd, { seed: [".env"] });
		const notifications: Array<{ msg: string; type: string }> = [];
		const runner = await createRunner(cwd, {
			onNotify: (msg, type) => notifications.push({ msg, type }),
		});
		await runner.emit({ type: "session_start", reason: "startup" });
		const workspace = wsPath(cwd, getSessionId(runner));
		// Point the newest Seed record at a checkout that does not exist.
		getSessionManager(runner).appendCustomEntry(SESSION_SEED_TYPE, {
			source: join(cwd, "gone-checkout"),
			paths: {},
		});
		// The session bookmark is created on the first agent start; unarchive
		// rebuilds from it.
		await runner.emitBeforeAgentStart(
			"seed",
			undefined,
			"You are helpful.",
			{
				skills: [],
				contextFiles: [],
				cwd: "",
			},
		);

		await runSillajje(runner, "archive");
		writeFileSync(join(cwd, ".env"), "SECRET=2\n");
		notifications.length = 0;

		await runSillajje(runner, "unarchive");
		expect(readFileSync(join(workspace, ".env"), "utf-8")).toBe(
			"SECRET=2\n",
		);
		expect(
			notifications.some(
				(n) => n.type === "warning" && n.msg.includes("gone-checkout"),
			),
		).toBe(true);
	});

	it("picks up a new file in a seeded directory on unarchive", async () => {
		const cwd = initSeedRepo();
		mkdirSync(join(cwd, ".local"), { recursive: true });
		writeFileSync(join(cwd, ".local/a.txt"), "a\n");
		writeSillajjeConfig(cwd, { seed: [".local"] });
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const workspace = wsPath(cwd, getSessionId(runner));
		await runner.emitBeforeAgentStart(
			"seed",
			undefined,
			"You are helpful.",
			{ skills: [], contextFiles: [], cwd: "" },
		);

		await runSillajje(runner, "archive");
		// The file appears in the checkout after the first copy.
		writeFileSync(join(cwd, ".local/b.txt"), "b\n");

		await runSillajje(runner, "unarchive");
		expect(readFileSync(join(workspace, ".local/b.txt"), "utf-8")).toBe(
			"b\n",
		);
	});
});
