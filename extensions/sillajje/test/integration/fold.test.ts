/**
 * Integration tests for the range-publishing fold against real jj, driven
 * through the registered command. The mechanism is the transaction recipe:
 * create an empty child of the target, duplicate the delta onto the target,
 * squash the copies into the child.
 */

import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import {
	addBareRemote,
	bareRef,
	createRunner,
	describeJj,
	getSessionId,
	initRepo,
	installDefaultSubGeneratorMock,
	jj,
	recordInteraction,
	runSillajje,
	sessionBookmark,
	wsPath,
} from "./_helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function simulateInteraction(
	runner: Awaited<ReturnType<typeof createRunner>>,
	prompt: string,
	response: string,
): Promise<void> {
	await runner.emitInput(prompt, undefined, "interactive");
	recordInteraction(runner, prompt, response);
	await runner.emit({ type: "agent_settled" });
}

function captureNotifications(
	runner: Awaited<ReturnType<typeof createRunner>>,
): Array<{ msg: string; type: "info" | "warning" | "error" }> {
	const notifications: Array<{
		msg: string;
		type: "info" | "warning" | "error";
	}> = [];
	runner.setUIContext(
		{
			setStatus: () => {},
			notify: (msg: string, type: "info" | "warning" | "error") =>
				notifications.push({ msg, type }),
			setEditorText: () => {},
			getEditorText: () => "",
		} as unknown as Parameters<typeof runner.setUIContext>[0],
		"tui",
	);
	return notifications;
}

/** The initial commit's change id in a fresh `initRepo`. */
function baseChangeId(cwd: string): string {
	return jj(["log", "-r", "@-", "--no-graph", "-T", "change_id"], cwd);
}

/** Children of a rev, as `{ id, description }`. */
function childrenOf(
	cwd: string,
	rev: string,
): Array<{ id: string; description: string }> {
	const out = jj(
		[
			"log",
			"-r",
			`children(${rev})`,
			"--no-graph",
			"-T",
			'change_id ++ "|" ++ description.first_line() ++ "\\n"',
		],
		cwd,
	);
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [id, ...rest] = line.split("|");
			return { id: id ?? "", description: rest.join("|") };
		});
}

/** A commit's full description. */
function description(cwd: string, rev: string): string {
	return jj(["log", "-r", rev, "--no-graph", "-T", "description"], cwd);
}

/** A commit's change id. */
function changeId(cwd: string, rev: string): string {
	return jj(["log", "-r", rev, "--no-graph", "-T", "change_id"], cwd);
}

/** A commit's id. */
function commitId(cwd: string, rev: string): string {
	return jj(["log", "-r", rev, "--no-graph", "-T", "commit_id"], cwd);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
	installDefaultSubGeneratorMock();
});

describeJj("sillajje fold", () => {
	it("folds the current session into one child of main, leaving the source unchanged", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		writeFileSync(join(workspace, "session.txt"), "session work\n");
		await simulateInteraction(runner, "Session change", "Done.");
		const sourceBefore = changeId(cwd, sessionBookmark(sessionId));

		// Advance main.
		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		execSync("jj describe -m 'feat: upstream'", { cwd, stdio: "pipe" });
		execSync("jj bookmark set main -r @", { cwd, stdio: "pipe" });

		await runSillajje(runner, "fold -s @ -o main");

		// Exactly one child of main, carrying the session work.
		const children = childrenOf(cwd, "main");
		expect(children).toHaveLength(1);
		const folded = children[0];
		const desc = description(cwd, folded.id);
		expect(desc).toContain("test subject");
		expect(desc).toContain("Summary:");
		expect(desc).toContain("Ref:");
		expect(desc).not.toContain("Meta:");
		expect(desc).not.toContain("Loop:");
		const files = jj(["file", "list", "-r", folded.id], cwd);
		expect(files).toContain("session.txt");
		expect(files).toContain("upstream.txt");

		// The source branch is unchanged.
		expect(changeId(cwd, sessionBookmark(sessionId))).toBe(sourceBefore);

		// The success notification names the target.
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining("folded onto main"),
			}),
		);
	}, 30_000);

	it("updates a session from its last stamp, not the workspace working copy", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		writeFileSync(join(workspace, "one.txt"), "one\n");
		await simulateInteraction(runner, "First", "Done.");

		// Advance main.
		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		execSync("jj describe -m 'feat: upstream'", { cwd, stdio: "pipe" });
		execSync("jj bookmark set main -r @", { cwd, stdio: "pipe" });

		await runSillajje(runner, "fold -s @ -o main --name review");

		// A second interaction stamps new work on top of the first stamp.
		writeFileSync(join(workspace, "two.txt"), "two\n");
		await simulateInteraction(runner, "Second", "Done.");
		await runSillajje(runner, "fold -s @ --update review");

		const files = jj(["file", "list", "-r", "review"], cwd);
		expect(files).toContain("one.txt");
		expect(files).toContain("two.txt");
	}, 30_000);

	it("folds a rev source with -r", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		// main advances.
		jj(["new", base, "-m", "upstream"], cwd);
		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		// feat branches from base.
		jj(["new", base, "-m", "feat work"], cwd);
		writeFileSync(join(cwd, "feat.txt"), "feat\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);
		const featBefore = changeId(cwd, "feat");

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);

		await runSillajje(runner, "fold -r feat -o main");

		const children = childrenOf(cwd, "main");
		expect(children).toHaveLength(1);
		const files = jj(["file", "list", "-r", children[0].id], cwd);
		expect(files).toContain("feat.txt");
		expect(files).toContain("upstream.txt");
		expect(changeId(cwd, "feat")).toBe(featBefore);
	}, 30_000);

	it("folds a rev source whose range contains a merge with the target", async () => {
		const cwd = initRepo();

		// A shared base with one file.
		writeFileSync(join(cwd, "shared.txt"), "base\n");
		jj(["describe", "-m", "base"], cwd);
		const base = changeId(cwd, "@");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		// feat diverges from base.
		jj(["new", base, "-m", "feat"], cwd);
		writeFileSync(join(cwd, "shared.txt"), "feat\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		// main diverges from base with a conflicting edit.
		jj(["new", base, "-m", "trunk"], cwd);
		writeFileSync(join(cwd, "shared.txt"), "main\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		// feat merges main and resolves the conflict. This is the shape a
		// session has after it incorporates the trunk before folding.
		jj(["new", "feat", "main", "-m", "merge trunk"], cwd);
		writeFileSync(join(cwd, "shared.txt"), "resolved\n");
		jj(["new", "-m", "tip"], cwd);
		jj(["bookmark", "create", "src", "-r", "@"], cwd);
		// Move the working copy off the source so the harness's files do not get
		// snapped into it.
		jj(["new", "-m", "after"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		await runSillajje(runner, "fold -r src -o main");

		const children = childrenOf(cwd, "main");
		// The source merge is itself a child of main; the folded change is the
		// one carrying the generated body (`Ref:`).
		const folded = children.find((c) =>
			description(cwd, c.id).includes("Ref:"),
		);
		expect(folded).toBeDefined();
		expect(
			jj(["file", "show", "-r", folded?.id ?? "", "shared.txt"], cwd),
		).toBe("resolved");
		expect(
			jj(["file", "list", "-r", folded?.id ?? ""], cwd).split("\n"),
		).toEqual(["README.md", "shared.txt"]);
		expect(notifications.some((n) => n.msg.includes("conflict"))).toBe(
			false,
		);
	}, 30_000);

	it("reports no-changes when a merge source adds no net content", async () => {
		const cwd = initRepo();
		writeFileSync(join(cwd, "base.txt"), "base\n");
		jj(["describe", "-m", "base"], cwd);
		const base = changeId(cwd, "@");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		jj(["new", base, "-m", "trunk"], cwd);
		writeFileSync(join(cwd, "trunk.txt"), "trunk\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		jj(["new", base, "-m", "feat"], cwd);
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		jj(["new", "feat", "main", "-m", "merge trunk"], cwd);
		// Bookmark the merge as the source, then move the working copy onto a
		// child. The test harness writes into the working copy, and jj
		// snapshots it; keeping the source off the working copy keeps its tree
		// clean so the only question is the merge itself.
		jj(["bookmark", "create", "src", "-r", "@"], cwd);
		jj(["new", "-m", "after"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		await runSillajje(runner, "fold -r src -o main");

		const folded = childrenOf(cwd, "main").filter((c) =>
			description(cwd, c.id).includes("Ref:"),
		);
		expect(folded).toHaveLength(0);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				msg: expect.stringContaining("no new changes"),
			}),
		);
	}, 30_000);

	it("rolls the whole fold back on a conflict", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		// main and feat edit the same file differently.
		jj(["new", base, "-m", "upstream"], cwd);
		writeFileSync(join(cwd, "file.txt"), "upstream\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		jj(["new", base, "-m", "feat"], cwd);
		writeFileSync(join(cwd, "file.txt"), "feat\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);
		const featBefore = changeId(cwd, "feat");
		const mainBefore = changeId(cwd, "main");

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		await runSillajje(runner, "fold -r feat -o main");

		// Nothing folded, no bookmark moved.
		expect(childrenOf(cwd, "main")).toHaveLength(0);
		expect(changeId(cwd, "main")).toBe(mainBefore);
		expect(changeId(cwd, "feat")).toBe(featBefore);

		const conflict = notifications.find(
			(n) => n.type === "warning" && n.msg.includes("conflict"),
		);
		expect(conflict).toBeDefined();
		expect(conflict?.msg).toContain("file.txt");
		expect(
			notifications.some(
				(n) => n.type === "info" && n.msg.includes("folded onto"),
			),
		).toBe(false);
	}, 30_000);

	it("reports no-changes for an empty delta", async () => {
		const cwd = initRepo();
		execSync("jj bookmark set main -r @", { cwd, stdio: "pipe" });

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		await runSillajje(runner, "fold -r main -o main");

		expect(childrenOf(cwd, "main")).toHaveLength(0);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining("no new changes"),
			}),
		);
	}, 30_000);

	it("appends only the new commits when --update targets the review branch", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["new", base, "-m", "upstream"], cwd);
		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		jj(["new", base, "-m", "D"], cwd);
		writeFileSync(join(cwd, "d.txt"), "d\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);

		// Publish the whole delta under main and name the review branch.
		await runSillajje(runner, "fold -r feat -o main --name review");

		// Add a new commit to feat and update the review branch.
		jj(["new", "feat", "-m", "E"], cwd);
		writeFileSync(join(cwd, "e.txt"), "e\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		await runSillajje(runner, "fold -r feat --update review");

		const files = jj(["file", "list", "-r", "review"], cwd);
		expect(files).toContain("d.txt");
		expect(files).toContain("e.txt");

		// The marker is keyed by source and target, and records the new tip.
		expect(changeId(cwd, "sillajje/folded/feat/review")).toBe(
			changeId(cwd, "feat"),
		);
	}, 30_000);

	it("a plain fold ignores the recorded marker and re-aggregates from the fork point", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["new", base, "-m", "upstream"], cwd);
		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		jj(["new", base, "-m", "D"], cwd);
		writeFileSync(join(cwd, "d.txt"), "d\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);

		await runSillajje(runner, "fold -r feat -o main");

		jj(["new", "feat", "-m", "E"], cwd);
		writeFileSync(join(cwd, "e.txt"), "e\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		// No --update: the whole range is published again, so the second
		// folded change carries d.txt, not only e.txt.
		await runSillajje(runner, "fold -r feat -o main");

		const foldedWithE = childrenOf(cwd, "main")
			.map((c) => ({ c, files: jj(["file", "list", "-r", c.id], cwd) }))
			.find((x) => x.files.includes("e.txt"));
		expect(foldedWithE).toBeDefined();
		expect(foldedWithE?.files).toContain("d.txt");
	}, 30_000);

	it("keeps a separate marker per review branch", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["new", base, "-m", "D"], cwd);
		writeFileSync(join(cwd, "d.txt"), "d\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);

		// Two review branches, each named on its first fold.
		await runSillajje(runner, `fold -r feat -o ${base} --name review-a`);
		await runSillajje(runner, `fold -r feat -o ${base} --name review-b`);

		jj(["new", "feat", "-m", "E"], cwd);
		writeFileSync(join(cwd, "e.txt"), "e\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		await runSillajje(runner, "fold -r feat --update review-a");

		// review-a moved forward; review-b still records the first tip.
		expect(changeId(cwd, "sillajje/folded/feat/review-a")).toBe(
			changeId(cwd, "feat"),
		);
		expect(changeId(cwd, "sillajje/folded/feat/review-b")).not.toBe(
			changeId(cwd, "feat"),
		);
		expect(jj(["file", "list", "-r", "review-a"], cwd)).toContain("e.txt");
		expect(jj(["file", "list", "-r", "review-b"], cwd)).not.toContain(
			"e.txt",
		);
	}, 30_000);

	it("--land advances the target bookmark; without it the bookmark is untouched", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["new", base, "-m", "upstream"], cwd);
		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);
		const mainBefore = changeId(cwd, "main");

		jj(["new", base, "-m", "feat"], cwd);
		writeFileSync(join(cwd, "feat.txt"), "feat\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);

		// Without --land the target bookmark does not move.
		await runSillajje(runner, "fold -r feat -o main");
		expect(changeId(cwd, "main")).toBe(mainBefore);

		// Add work and fold again with --land.
		jj(["new", "feat", "-m", "feat2"], cwd);
		writeFileSync(join(cwd, "feat2.txt"), "feat2\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);
		await runSillajje(runner, "fold -r feat -o main --land");

		const mainAfter = changeId(cwd, "main");
		expect(mainAfter).not.toBe(mainBefore);
		expect(childrenOf(cwd, mainBefore).map((c) => c.id)).toContain(
			mainAfter,
		);
	}, 30_000);

	it("--land errors when --onto is not a single local bookmark", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		// A target with no bookmark.
		jj(["new", base, "-m", "target"], cwd);
		writeFileSync(join(cwd, "target.txt"), "target\n");
		const targetId = changeId(cwd, "@");

		jj(["new", base, "-m", "feat"], cwd);
		writeFileSync(join(cwd, "feat.txt"), "feat\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		await runSillajje(runner, `fold -r feat -o ${targetId} --land`);

		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "warning",
				msg: expect.stringContaining("exactly one local bookmark"),
			}),
		);
	}, 30_000);

	it("--update --push advances the review branch on the remote", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["new", base, "-m", "upstream"], cwd);
		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		jj(["new", base, "-m", "D"], cwd);
		writeFileSync(join(cwd, "d.txt"), "d\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		// The first fold names the review branch locally; nothing is remote.
		await runSillajje(runner, "fold -r feat -o main --name review");
		const remote = addBareRemote(cwd);
		expect(bareRef(remote, "review")).toBeUndefined();

		// Adding work and updating with --push creates the remote branch.
		jj(["new", "feat", "-m", "E"], cwd);
		writeFileSync(join(cwd, "e.txt"), "e\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);
		await runSillajje(runner, "fold -r feat --update review --push");
		expect(bareRef(remote, "review")).toBe(commitId(cwd, "review"));

		// The bookmark is now tracked; the next push moves the remote.
		jj(["new", "feat", "-m", "F"], cwd);
		writeFileSync(join(cwd, "f.txt"), "f\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);
		await runSillajje(runner, "fold -r feat --update review --push");
		expect(bareRef(remote, "review")).toBe(commitId(cwd, "review"));
		expect(jj(["file", "list", "-r", "review"], cwd)).toContain("f.txt");
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining("pushed review@origin"),
			}),
		);
	}, 30_000);

	it("--land --push advances the landed bookmark on the remote", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["new", base, "-m", "upstream"], cwd);
		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		jj(["new", base, "-m", "feat"], cwd);
		writeFileSync(join(cwd, "feat.txt"), "feat\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		const remote = addBareRemote(cwd);
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);

		await runSillajje(runner, "fold -r feat -o main --land --push");
		expect(bareRef(remote, "main")).toBe(commitId(cwd, "main"));
	}, 30_000);

	it("warns and keeps the folded change when the push fails", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["bookmark", "set", "main", "-r", base], cwd);
		jj(["new", base, "-m", "feat"], cwd);
		writeFileSync(join(cwd, "feat.txt"), "feat\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);
		jj(
			["git", "remote", "add", "origin", "/nonexistent/sillajje-remote"],
			cwd,
		);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		await runSillajje(runner, "fold -r feat -o main --land --push");

		// The fold landed despite the failed push.
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "warning",
				msg: expect.stringContaining("could not push"),
			}),
		);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining("folded onto main"),
			}),
		);
	}, 30_000);

	it("pushes before archiving the session workspace", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		writeFileSync(join(workspace, "one.txt"), "one\n");
		await simulateInteraction(runner, "First", "Done.");

		// Advance main and publish a local review branch.
		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		execSync("jj describe -m 'feat: upstream'", { cwd, stdio: "pipe" });
		execSync("jj bookmark set main -r @", { cwd, stdio: "pipe" });
		await runSillajje(runner, "fold -s @ -o main --name review");
		const remote = addBareRemote(cwd);

		// Update, push, and archive: the push runs before the workspace goes.
		writeFileSync(join(workspace, "two.txt"), "two\n");
		await simulateInteraction(runner, "Second", "Done.");
		await runSillajje(runner, "fold -s @ --update review --push --archive");

		// A push after archive would run in the removed workspace and fail,
		// leaving no remote branch and a warning. The branch, the pushed
		// notice, and the absent warning together prove the order. The pushed
		// commit id is not asserted: the session log is still written and jj
		// rewrites the change after the push, so only the change id is stable.
		expect(bareRef(remote, "review")).toBeDefined();
		expect(changeId(cwd, bareRef(remote, "review") ?? "")).toBe(
			changeId(cwd, "review"),
		);
		expect(existsSync(workspace)).toBe(false);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining("pushed review"),
			}),
		);
		expect(notifications).not.toContainEqual(
			expect.objectContaining({
				type: "warning",
				msg: expect.stringContaining("could not push"),
			}),
		);
	}, 30_000);

	it("archives the session after a successful --archive fold", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		writeFileSync(join(workspace, "session.txt"), "session work\n");
		await simulateInteraction(runner, "Session change", "Done.");

		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		execSync("jj describe -m 'feat: upstream'", { cwd, stdio: "pipe" });
		execSync("jj bookmark set main -r @", { cwd, stdio: "pipe" });

		await runSillajje(runner, "fold -s @ -o main --archive");

		// The workspace is gone; the bookmark survives as sillage.
		expect(existsSync(workspace)).toBe(false);
		expect(jj(["bookmark", "list"], cwd)).toContain(
			sessionBookmark(sessionId),
		);
		const inputResult = await runner.emitInput(
			"more work",
			undefined,
			"interactive",
		);
		expect(inputResult).toEqual({ action: "handled" });
	}, 30_000);

	it("rejects --archive with a rev source", async () => {
		const cwd = initRepo();
		execSync("jj bookmark set main -r @", { cwd, stdio: "pipe" });

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		await runSillajje(runner, "fold -r main -o main --archive");

		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "warning",
				msg: expect.stringContaining(
					"--archive requires a session source",
				),
			}),
		);
	}, 30_000);

	it("folds an archived session from its bookmark", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		writeFileSync(join(workspace, "session.txt"), "session work\n");
		await simulateInteraction(runner, "Session change", "Done.");

		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		execSync("jj describe -m 'feat: upstream'", { cwd, stdio: "pipe" });
		execSync("jj bookmark set main -r @", { cwd, stdio: "pipe" });

		await runSillajje(runner, "archive");
		expect(existsSync(workspace)).toBe(false);

		await runSillajje(runner, `fold -s ${sessionId} -o main`);

		const children = childrenOf(cwd, "main");
		expect(children).toHaveLength(1);
		const files = jj(["file", "list", "-r", children[0].id], cwd);
		expect(files).toContain("session.txt");
	}, 30_000);

	it("prints help for -h, --help, and a target-less invocation", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		await runSillajje(runner, "fold");
		await runSillajje(runner, "fold -h");
		await runSillajje(runner, "fold --help");

		const helps = notifications.filter(
			(n) => n.type === "info" && n.msg.includes("usage: /sillajje:fold"),
		);
		expect(helps).toHaveLength(3);
	}, 30_000);
});
