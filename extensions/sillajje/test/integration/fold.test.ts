/**
 * Integration tests for the range-publishing fold against real jj, driven
 * through the registered command. The mechanism is the transaction recipe:
 * create an empty child of the target, duplicate the delta onto the target,
 * squash the copies into the child.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { SESSION_BASE_TYPE } from "../../src/session-base.js";
import {
	addBareRemote,
	bareRef,
	captureUi,
	createRunner,
	describeJj,
	getSessionId,
	getSessionManager,
	initRepo,
	installDefaultSubGeneratorMock,
	jj,
	recordInteraction,
	recordsIn,
	runSillajje,
	sessionBookmark,
	sessionKeyId,
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
			setWidget: () => {},
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

/** Advance `main` with one upstream file; returns the initial commit's change id. */
function seedUpstreamMain(cwd: string): string {
	const base = baseChangeId(cwd);
	jj(["new", base, "-m", "upstream"], cwd);
	writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
	jj(["bookmark", "set", "main", "-r", "@"], cwd);
	return base;
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

		const foldRecords = recordsIn(
			getSessionManager(runner).getBranch(),
			"fold",
		);
		expect(foldRecords.map((r) => r.stage)).toEqual(["start", "done"]);
		expect(foldRecords[0]).toMatchObject({
			operation: "fold",
			input: { onto: "main" },
		});
		expect(foldRecords[1]).toMatchObject({
			stage: "done",
			resolved: { target: "main" },
			generator: { fallbacks: [] },
		});

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

	it("moves the caller's home revision onto the folded change", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		// Trunk is the initial commit; the home revision sits on top of it.
		jj(["bookmark", "set", "main", "-r", "@-"], cwd);
		const homeChange = changeId(cwd, "@");

		writeFileSync(join(workspace, "session.txt"), "session work\n");
		await simulateInteraction(runner, "Session change", "Done.");

		await runSillajje(runner, "fold -s @ -o main --rebase @");

		// The folded change is the only child of main; the home revision moved
		// onto it.
		const folded = childrenOf(cwd, "main")[0];
		expect(folded).toBeDefined();
		expect(changeId(cwd, "@")).toBe(homeChange);
		expect(commitId(cwd, "@-")).toBe(commitId(cwd, folded.id));

		// --rebase does not touch the published body or its provenance.
		const desc = description(cwd, folded.id);
		expect(desc).toContain("Ref:");
		expect(desc).not.toContain("Meta:");
		expect(desc).not.toContain("Loop:");

		// The caller's working copy is current, not stale: this read aborts if
		// the fold left the workspace stale.
		expect(
			jj(["log", "-r", "@", "--no-graph", "-T", "change_id"], cwd),
		).toBe(homeChange);

		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining("rebased @"),
			}),
		);
	}, 30_000);

	it("moves a subtree and its bookmark onto the folded change", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["new", base, "-m", "upstream"], cwd);
		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		// A two-commit home branch, bookmarked at its root.
		jj(["new", "main", "-m", "home1"], cwd);
		writeFileSync(join(cwd, "home1.txt"), "home1\n");
		jj(["bookmark", "set", "home", "-r", "@"], cwd);
		const homeRoot = changeId(cwd, "home");
		jj(["new", "-m", "home2"], cwd);
		writeFileSync(join(cwd, "home2.txt"), "home2\n");
		const homeTip = changeId(cwd, "@");

		// A source branch to fold.
		jj(["new", base, "-m", "src"], cwd);
		writeFileSync(join(cwd, "src.txt"), "src\n");
		jj(["bookmark", "set", "src", "-r", "@"], cwd);
		jj(["new", "-m", "after"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);

		await runSillajje(runner, "fold -r src -o main --rebase home");

		const folded = childrenOf(cwd, "main")[0];
		expect(folded).toBeDefined();
		// home1 moved under the folded change, home2 followed, bookmark intact.
		expect(changeId(cwd, "home")).toBe(homeRoot);
		expect(
			jj(
				[
					"log",
					"-r",
					"home",
					"--no-graph",
					"-T",
					'parents.map(|p| p.change_id()).join(" ")',
				],
				cwd,
			),
		).toBe(folded?.id);
		expect(childrenOf(cwd, "home")[0]?.id).toBe(homeTip);
	}, 30_000);

	it("rejects --rebase naming an ancestor of the target", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		// main is a child of `anc`.
		jj(["new", base, "-m", "anc"], cwd);
		writeFileSync(join(cwd, "anc.txt"), "anc\n");
		jj(["bookmark", "set", "anc", "-r", "@"], cwd);
		jj(["new", "-m", "main"], cwd);
		writeFileSync(join(cwd, "main.txt"), "main\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		// A source branch to fold.
		jj(["new", base, "-m", "src"], cwd);
		writeFileSync(join(cwd, "src.txt"), "src\n");
		jj(["bookmark", "set", "src", "-r", "@"], cwd);
		jj(["new", "-m", "after"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		await runSillajje(runner, "fold -r src -o main --rebase anc");

		expect(childrenOf(cwd, "main")).toHaveLength(0);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "warning",
				msg: expect.stringContaining("ancestor"),
			}),
		);
	}, 30_000);

	it("rejects --rebase naming root()", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["new", base, "-m", "main"], cwd);
		writeFileSync(join(cwd, "main.txt"), "main\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		jj(["new", base, "-m", "src"], cwd);
		writeFileSync(join(cwd, "src.txt"), "src\n");
		jj(["bookmark", "set", "src", "-r", "@"], cwd);
		jj(["new", "-m", "after"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		await runSillajje(runner, "fold -r src -o main --rebase root()");

		expect(childrenOf(cwd, "main")).toHaveLength(0);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "warning",
				msg: expect.stringContaining("--rebase"),
			}),
		);
	}, 30_000);

	it("rejects --rebase naming an immutable revision", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["new", base, "-m", "main"], cwd);
		writeFileSync(join(cwd, "main.txt"), "main\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		// A sibling branch, marked immutable so jj would refuse to rewrite it.
		jj(["new", base, "-m", "home"], cwd);
		writeFileSync(join(cwd, "home.txt"), "home\n");
		jj(["bookmark", "set", "home", "-r", "@"], cwd);
		jj(
			[
				"config",
				"set",
				"--repo",
				'revset-aliases."immutable_heads()"',
				"home",
			],
			cwd,
		);

		jj(["new", base, "-m", "src"], cwd);
		writeFileSync(join(cwd, "src.txt"), "src\n");
		jj(["bookmark", "set", "src", "-r", "@"], cwd);
		jj(["new", "-m", "after"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		await runSillajje(runner, "fold -r src -o main --rebase home");

		expect(childrenOf(cwd, "main")).toHaveLength(0);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "warning",
				msg: expect.stringContaining("immutable"),
			}),
		);
	}, 30_000);

	it("replays a revision the fold already published as an empty commit", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["new", base, "-m", "upstream"], cwd);
		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		jj(["new", base, "-m", "src"], cwd);
		writeFileSync(join(cwd, "src.txt"), "src\n");
		jj(["bookmark", "set", "src", "-r", "@"], cwd);
		const srcBefore = changeId(cwd, "src");
		jj(["new", "-m", "after"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		await runSillajje(runner, "fold -r src -o main --rebase src");

		// The fold published src's delta, then moved src onto it. The replay is
		// empty, not a conflict, and the fold succeeds.
		const folded = childrenOf(cwd, "main")[0];
		expect(folded).toBeDefined();
		expect(changeId(cwd, "src")).toBe(srcBefore);
		expect(
			jj(
				[
					"log",
					"-r",
					"src",
					"--no-graph",
					"-T",
					'parents.map(|p| p.change_id()).join(" ")',
				],
				cwd,
			),
		).toBe(folded?.id);
		expect(jj(["diff", "-r", "src"], cwd)).toBe("");
		expect(notifications.some((n) => n.msg.includes("conflict"))).toBe(
			false,
		);
	}, 30_000);

	it("rolls back when the rebase conflicts", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["new", base, "-m", "upstream"], cwd);
		writeFileSync(join(cwd, "file.txt"), "upstream\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		// src folds cleanly: it adds an unrelated file.
		jj(["new", base, "-m", "src"], cwd);
		writeFileSync(join(cwd, "src.txt"), "src\n");
		jj(["bookmark", "set", "src", "-r", "@"], cwd);

		// other edits the same path main added, so the rebase onto the fold
		// conflicts.
		jj(["new", base, "-m", "other"], cwd);
		writeFileSync(join(cwd, "file.txt"), "other\n");
		jj(["bookmark", "set", "other", "-r", "@"], cwd);
		const otherBefore = changeId(cwd, "other");
		jj(["new", "-m", "after"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		await runSillajje(runner, "fold -r src -o main --rebase other");

		// The whole fold rolled back: nothing published, nothing moved.
		expect(childrenOf(cwd, "main")).toHaveLength(0);
		expect(changeId(cwd, "other")).toBe(otherBefore);
		const conflict = notifications.find(
			(n) => n.type === "warning" && n.msg.includes("conflict"),
		);
		expect(conflict).toBeDefined();
		expect(conflict?.msg).toContain("file.txt");
	}, 30_000);

	it("rejects --rebase naming a merge revision", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["new", base, "-m", "main"], cwd);
		writeFileSync(join(cwd, "main.txt"), "main\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		jj(["new", base, "-m", "side"], cwd);
		writeFileSync(join(cwd, "side.txt"), "side\n");
		jj(["bookmark", "set", "side", "-r", "@"], cwd);

		// A merge of main and side, bookmarked as the revision to move. jj's
		// rebase would drop the side parent, so --rebase refuses it.
		jj(["new", "main", "side", "-m", "home"], cwd);
		writeFileSync(join(cwd, "home.txt"), "home\n");
		jj(["bookmark", "set", "home", "-r", "@"], cwd);

		jj(["new", base, "-m", "src"], cwd);
		writeFileSync(join(cwd, "src.txt"), "src\n");
		jj(["bookmark", "set", "src", "-r", "@"], cwd);
		jj(["new", "-m", "after"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		await runSillajje(runner, "fold -r src -o main --rebase home");

		expect(
			childrenOf(cwd, "main").filter((c) =>
				description(cwd, c.id).includes("Ref:"),
			),
		).toHaveLength(0);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "warning",
				msg: expect.stringContaining("merge"),
			}),
		);
	}, 30_000);

	it("advances the target and moves the home revision with --update --rebase", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		jj(["bookmark", "set", "main", "-r", "@-"], cwd);
		const homeChange = changeId(cwd, "@");

		writeFileSync(join(workspace, "session.txt"), "session work\n");
		await simulateInteraction(runner, "Session change", "Done.");

		await runSillajje(runner, "fold -s @ -o main --update --rebase @");

		// main advanced to the folded change, and the home revision now sits on
		// top of it.
		const advanced = changeId(cwd, "main");
		expect(description(cwd, "main")).toContain("Ref:");
		expect(changeId(cwd, "@")).toBe(homeChange);
		expect(changeId(cwd, "@-")).toBe(advanced);
		// The Folded source marker records the source tip, untouched by the
		// rebase.
		expect(changeId(cwd, `slj/f/main/${sessionKeyId(sessionId)}`)).toBe(
			changeId(cwd, sessionBookmark(sessionId)),
		);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining("rebased @"),
			}),
		);
	}, 30_000);

	it("names a review branch and moves the home revision with --rebase", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["new", base, "-m", "main"], cwd);
		writeFileSync(join(cwd, "main.txt"), "main\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		jj(["new", "main", "-m", "home"], cwd);
		const homeChange = changeId(cwd, "@");
		jj(["bookmark", "set", "home", "-r", "@"], cwd);

		jj(["new", base, "-m", "src"], cwd);
		writeFileSync(join(cwd, "src.txt"), "src\n");
		jj(["bookmark", "set", "src", "-r", "@"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);

		await runSillajje(
			runner,
			"fold -r src -o main --named review --rebase home",
		);

		expect(description(cwd, "review")).toContain("Ref:");
		expect(changeId(cwd, "home")).toBe(homeChange);
		expect(commitId(cwd, "home-")).toBe(commitId(cwd, "review"));
		// The marker is keyed by the named destination.
		expect(changeId(cwd, "slj/f/review/src")).toBe(changeId(cwd, "src"));
	}, 30_000);

	it("excludes a path and still moves the home revision with --rebase", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["new", base, "-m", "main"], cwd);
		writeFileSync(join(cwd, "main.txt"), "main\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		jj(["new", "main", "-m", "home"], cwd);
		const homeChange = changeId(cwd, "@");
		jj(["bookmark", "set", "home", "-r", "@"], cwd);

		jj(["new", base, "-m", "src"], cwd);
		writeFileSync(join(cwd, "src.txt"), "src\n");
		writeFileSync(join(cwd, "skip.txt"), "skip\n");
		jj(["bookmark", "set", "src", "-r", "@"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);

		await runSillajje(
			runner,
			"fold -r src -o main --exclude skip.txt --rebase home",
		);

		const folded = childrenOf(cwd, "main")[0];
		expect(folded).toBeDefined();
		const files = jj(["file", "list", "-r", folded.id], cwd);
		expect(files).toContain("src.txt");
		expect(files).not.toContain("skip.txt");
		expect(changeId(cwd, "home")).toBe(homeChange);
		expect(commitId(cwd, "home-")).toBe(commitId(cwd, folded.id));
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

		await runSillajje(runner, "fold -s @ -o main --named review");

		// A second interaction stamps new work on top of the first stamp.
		writeFileSync(join(workspace, "two.txt"), "two\n");
		await simulateInteraction(runner, "Second", "Done.");
		await runSillajje(runner, "fold -s @ -o review --update");

		const files = jj(["file", "list", "-r", "review"], cwd);
		expect(files).toContain("one.txt");
		expect(files).toContain("two.txt");
	}, 30_000);

	it("appends onto the branch from a session handed off with new -s", async () => {
		const cwd = initRepo();

		// Session A seals its work and publishes the review branch.
		const runnerA = await createRunner(cwd);
		await runnerA.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runnerA);
		const sessionA = getSessionId(runnerA);
		const workspaceA = wsPath(cwd, sessionA);
		writeFileSync(join(workspaceA, "one.txt"), "one\n");
		await simulateInteraction(runnerA, "First", "Done.");

		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		execSync("jj describe -m 'feat: upstream'", { cwd, stdio: "pipe" });
		execSync("jj bookmark set main -r @", { cwd, stdio: "pipe" });
		await runSillajje(runnerA, "fold -s @ -o main --named review");

		// Session B branches from A's last seal, as `/sillajje:new -s A` does.
		const runnerB = await createRunner(cwd);
		getSessionManager(runnerB).appendCustomEntry(SESSION_BASE_TYPE, {
			base: sessionBookmark(sessionA),
			label: sessionA,
		});
		await runnerB.emit({ type: "session_start", reason: "new" });
		const notificationsB = captureNotifications(runnerB);
		const sessionB = getSessionId(runnerB);
		const workspaceB = wsPath(cwd, sessionB);
		writeFileSync(join(workspaceB, "two.txt"), "two\n");
		await simulateInteraction(runnerB, "Second", "Done.");

		await runSillajje(runnerB, "fold -s @ -o review --update");

		const files = jj(["file", "list", "-r", "review"], cwd);
		expect(files).toContain("one.txt");
		expect(files).toContain("two.txt");
		// The handoff writes its own source's marker; the base came from s1's
		// marker, found by ancestry.
		expect(changeId(cwd, `slj/f/review/${sessionKeyId(sessionB)}`)).toBe(
			changeId(cwd, sessionBookmark(sessionB)),
		);
		expect(notificationsB).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining("folded onto review"),
			}),
		);
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

	it("appends only the new commits onto the review branch", async () => {
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
		await runSillajje(runner, "fold -r feat -o main --named review");

		// Add a new commit to feat and update the review branch.
		jj(["new", "feat", "-m", "E"], cwd);
		writeFileSync(join(cwd, "e.txt"), "e\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		await runSillajje(runner, "fold -r feat -o review --update");

		const files = jj(["file", "list", "-r", "review"], cwd);
		expect(files).toContain("d.txt");
		expect(files).toContain("e.txt");

		// The source's marker records the new tip.
		expect(changeId(cwd, "slj/f/review/feat")).toBe(changeId(cwd, "feat"));
	}, 30_000);

	it("writes a jj-legal marker for a nested destination", async () => {
		const cwd = initRepo();
		const base = seedUpstreamMain(cwd);

		jj(["new", base, "-m", "D"], cwd);
		writeFileSync(join(cwd, "d.txt"), "d\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);

		// `review/feat` contains `/`, which is legal in a bookmark name but
		// blurs the marker's destination boundary: a fold for `review` would read
		// the markers written for `review/extra`. The encoder escapes `/` to one
		// segment, and the marker ends up a bookmark name jj accepts.
		await runSillajje(runner, "fold -r feat -o main --named review/feat");

		expect(changeId(cwd, "review/feat")).toBeDefined();
		expect(changeId(cwd, "slj/f/review_2f_feat/feat")).toBe(
			changeId(cwd, "feat"),
		);
	}, 30_000);

	it("writes a jj-legal marker for destinations jj cannot carry literally", async () => {
		const cwd = initRepo();
		const base = seedUpstreamMain(cwd);

		jj(["new", base, "-m", "D"], cwd);
		writeFileSync(join(cwd, "d.txt"), "d\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);

		// `*` is legal in a jj bookmark but not in a git ref, so the marker must
		// escape it. `𝕏` is an astral letter: one code point, and the escaped
		// marker must still be a bookmark jj accepts.
		const cases = [
			{ dest: "review*feat", marker: "slj/f/review_2a_feat/feat" },
			{ dest: "𝕏-release", marker: "slj/f/_1d54f_-release/feat" },
		];
		for (const { dest, marker } of cases) {
			await runSillajje(runner, `fold -r feat -o main --named ${dest}`);
			expect(changeId(cwd, dest)).toBeDefined();
			expect(changeId(cwd, marker)).toBe(changeId(cwd, "feat"));
		}
	}, 30_000);

	it("appends across a renamed source because the lookup is by ancestry", async () => {
		const cwd = initRepo();
		const base = seedUpstreamMain(cwd);

		jj(["new", base, "-m", "D"], cwd);
		writeFileSync(join(cwd, "d.txt"), "d\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		// The first fold keys the marker on the review branch.
		await runSillajje(runner, "fold -r feat -o main --named review");

		// The source bookmark changes name before the next fold. A marker keyed
		// on the source would miss and re-aggregate from the fork point.
		jj(["bookmark", "rename", "feat", "feat2"], cwd);
		jj(["new", "feat2", "-m", "E"], cwd);
		writeFileSync(join(cwd, "e.txt"), "e\n");
		jj(["bookmark", "set", "feat2", "-r", "@"], cwd);

		await runSillajje(runner, "fold -r feat2 -o review --update");

		expect(jj(["file", "list", "-r", "review"], cwd)).toContain("d.txt");
		expect(jj(["file", "list", "-r", "review"], cwd)).toContain("e.txt");
		// The renamed source writes its own marker; the base came from the old
		// source's marker, found by ancestry.
		expect(changeId(cwd, "slj/f/review/feat2")).toBe(
			changeId(cwd, "feat2"),
		);
		expect(changeId(cwd, "slj/f/review/feat")).not.toBe(
			changeId(cwd, "feat2"),
		);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining("folded onto review"),
			}),
		);
	}, 30_000);

	it("bases on the fork point when the Folded source marker is unrelated", async () => {
		const cwd = initRepo();
		const base = seedUpstreamMain(cwd);

		jj(["new", base, "-m", "D"], cwd);
		writeFileSync(join(cwd, "d.txt"), "d\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		jj(["new", base, "-m", "O"], cwd);
		writeFileSync(join(cwd, "o.txt"), "o\n");
		jj(["bookmark", "set", "other", "-r", "@"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);

		await runSillajje(runner, "fold -r feat -o main --named review");
		// `other` does not descend from the recorded tip, so the marker is not a
		// usable base.
		await runSillajje(runner, "fold -r other -o review --update");

		// The unrelated marker is not an ancestor, so the fold bases on the fork
		// point and still publishes other's work.
		expect(jj(["file", "list", "-r", "review"], cwd)).toContain("o.txt");
		expect(changeId(cwd, "slj/f/review/feat")).toBe(changeId(cwd, "feat"));
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining("folded onto review"),
			}),
		);
	}, 30_000);

	it("--no-marker ignores the Folded source marker and re-aggregates from the fork point", async () => {
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

		const dChange = changeId(cwd, "feat");
		await runSillajje(runner, "fold -r feat -o main --update");

		jj(["new", "feat", "-m", "E"], cwd);
		writeFileSync(join(cwd, "e.txt"), "e\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);
		const eChange = changeId(cwd, "feat");

		// --no-marker ignores the marker: the Ref spans the fork point, not D.
		await runSillajje(runner, "fold -r feat -o main --update --no-marker");

		const desc = description(cwd, "main");
		expect(desc).toContain(`Ref: ${base}..${eChange}`);
		expect(desc).not.toContain(`Ref: ${dChange}..${eChange}`);
	}, 30_000);

	it("a second --update fold appends only the new work via the marker", async () => {
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

		await runSillajje(runner, "fold -r feat -o main --update");

		jj(["new", "feat", "-m", "E"], cwd);
		writeFileSync(join(cwd, "e.txt"), "e\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		await runSillajje(runner, "fold -r feat -o main --update");

		// The marker makes the second fold's diff only e.txt; d.txt was
		// published by the first fold and is inherited.
		const summary = jj(["diff", "-r", "main", "--summary"], cwd);
		expect(summary).toContain("e.txt");
		expect(summary).not.toContain("d.txt");
		expect(changeId(cwd, "slj/f/main/feat")).toBe(changeId(cwd, "feat"));
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
		await runSillajje(runner, `fold -r feat -o ${base} --named review-a`);
		await runSillajje(runner, `fold -r feat -o ${base} --named review-b`);

		jj(["new", "feat", "-m", "E"], cwd);
		writeFileSync(join(cwd, "e.txt"), "e\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		await runSillajje(runner, "fold -r feat -o review-a --update");

		// review-a's source marker moved forward; review-b's still records the
		// first tip.
		expect(changeId(cwd, "slj/f/review-a/feat")).toBe(
			changeId(cwd, "feat"),
		);
		expect(changeId(cwd, "slj/f/review-b/feat")).not.toBe(
			changeId(cwd, "feat"),
		);
		expect(jj(["file", "list", "-r", "review-a"], cwd)).toContain("e.txt");
		expect(jj(["file", "list", "-r", "review-b"], cwd)).not.toContain(
			"e.txt",
		);
	}, 30_000);

	it("--update advances the target bookmark; without it the bookmark is untouched", async () => {
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

		// Without --update the target bookmark does not move.
		await runSillajje(runner, "fold -r feat -o main");
		expect(changeId(cwd, "main")).toBe(mainBefore);

		// Add work and fold again with --update.
		jj(["new", "feat", "-m", "feat2"], cwd);
		writeFileSync(join(cwd, "feat2.txt"), "feat2\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);
		await runSillajje(runner, "fold -r feat -o main --update");

		const mainAfter = changeId(cwd, "main");
		expect(mainAfter).not.toBe(mainBefore);
		expect(childrenOf(cwd, mainBefore).map((c) => c.id)).toContain(
			mainAfter,
		);
	}, 30_000);

	it("--update errors when --onto is not a single local bookmark", async () => {
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

		await runSillajje(runner, `fold -r feat -o ${targetId} --update`);

		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "warning",
				msg: expect.stringContaining("pass --update <bookmark>"),
			}),
		);
	}, 30_000);

	it("--push on an appended review branch advances the remote", async () => {
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
		await runSillajje(runner, "fold -r feat -o main --named review");
		const remote = addBareRemote(cwd);
		expect(bareRef(remote, "review")).toBeUndefined();

		// Adding work and updating with --push creates the remote branch.
		jj(["new", "feat", "-m", "E"], cwd);
		writeFileSync(join(cwd, "e.txt"), "e\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);
		await runSillajje(runner, "fold -r feat -o review --update --push");
		expect(bareRef(remote, "review")).toBe(commitId(cwd, "review"));

		// The bookmark is now tracked; the next push moves the remote.
		jj(["new", "feat", "-m", "F"], cwd);
		writeFileSync(join(cwd, "f.txt"), "f\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);
		await runSillajje(runner, "fold -r feat -o review --update --push");
		expect(bareRef(remote, "review")).toBe(commitId(cwd, "review"));
		expect(jj(["file", "list", "-r", "review"], cwd)).toContain("f.txt");
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining("pushed review@origin"),
			}),
		);
	}, 30_000);

	it("--update --push advances the landed bookmark on the remote", async () => {
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

		await runSillajje(runner, "fold -r feat -o main --update --push");
		expect(bareRef(remote, "main")).toBe(commitId(cwd, "main"));
	}, 30_000);

	it("pushes the advanced bookmark and moves the home revision with --rebase", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		// main, and a home revision on top of it.
		jj(["new", base, "-m", "upstream"], cwd);
		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);
		jj(["new", "-m", "home"], cwd);
		const homeChange = changeId(cwd, "@");
		jj(["bookmark", "set", "home", "-r", "@"], cwd);

		// A source branch to fold.
		jj(["new", base, "-m", "feat"], cwd);
		writeFileSync(join(cwd, "feat.txt"), "feat\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		const remote = addBareRemote(cwd);
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);

		await runSillajje(
			runner,
			"fold -r feat -o main --update --push --rebase home",
		);

		const advanced = commitId(cwd, "main");
		expect(bareRef(remote, "main")).toBe(advanced);
		expect(changeId(cwd, "home")).toBe(homeChange);
		expect(commitId(cwd, "home-")).toBe(advanced);
	}, 30_000);

	it("archives the session after moving the home revision with --rebase", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		jj(["bookmark", "set", "main", "-r", "@-"], cwd);
		const homeChange = changeId(cwd, "@");

		writeFileSync(join(workspace, "session.txt"), "session work\n");
		await simulateInteraction(runner, "Session change", "Done.");

		await runSillajje(runner, "fold -s @ -o main --archive --rebase @");

		// The home revision moved onto the folded change, and the session is
		// retired with its bookmark intact.
		const folded = childrenOf(cwd, "main")[0];
		expect(folded).toBeDefined();
		expect(changeId(cwd, "@")).toBe(homeChange);
		expect(commitId(cwd, "@-")).toBe(commitId(cwd, folded.id));
		expect(existsSync(workspace)).toBe(false);
		expect(jj(["bookmark", "list"], cwd)).toContain(
			sessionBookmark(sessionId),
		);
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

		await runSillajje(runner, "fold -r feat -o main --update --push");

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
		await runSillajje(runner, "fold -s @ -o main --named review");
		const remote = addBareRemote(cwd);

		// Update, push, and archive: the push runs before the workspace goes.
		writeFileSync(join(workspace, "two.txt"), "two\n");
		await simulateInteraction(runner, "Second", "Done.");
		await runSillajje(
			runner,
			"fold -s @ -o review --update --push --archive",
		);

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

	it("leaves excluded paths out of the folded change while the source keeps them", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		mkdirSync(join(workspace, ".scratch"), { recursive: true });
		writeFileSync(join(workspace, "session.txt"), "session work\n");
		writeFileSync(join(workspace, ".scratch", "ticket.md"), "ticket\n");
		await simulateInteraction(runner, "Session change", "Done.");

		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		execSync("jj describe -m 'feat: upstream'", { cwd, stdio: "pipe" });
		execSync("jj bookmark set main -r @", { cwd, stdio: "pipe" });

		await runSillajje(runner, "fold -s @ -o main --exclude .scratch/");

		const children = childrenOf(cwd, "main");
		expect(children).toHaveLength(1);
		const folded = children[0];
		const files = jj(["file", "list", "-r", folded?.id ?? ""], cwd);
		expect(files).toContain("session.txt");
		expect(files).not.toContain(".scratch/ticket.md");

		// The body records the paths the fold left behind.
		expect(description(cwd, folded?.id ?? "")).toContain(
			"Skipped: .scratch/",
		);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining("fold leaves out .scratch/"),
			}),
		);

		// The excluded path stays in the source branch.
		const source = jj(
			["file", "list", "-r", sessionBookmark(sessionId)],
			cwd,
		);
		expect(source).toContain(".scratch/ticket.md");
	}, 30_000);

	it("leaves no duplicated copy behind when an earlier copy empties", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		captureNotifications(runner);
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		// The first interaction touches only included work and the second only
		// the excluded path, so the partial squash empties the earlier copy.
		writeFileSync(join(workspace, "session.txt"), "session work\n");
		await simulateInteraction(runner, "Session change", "Done.");
		mkdirSync(join(workspace, ".scratch"), { recursive: true });
		writeFileSync(join(workspace, ".scratch", "ticket.md"), "ticket\n");
		await simulateInteraction(runner, "Ticket", "Done.");

		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		execSync("jj describe -m 'feat: upstream'", { cwd, stdio: "pipe" });
		execSync("jj bookmark set main -r @", { cwd, stdio: "pipe" });

		await runSillajje(runner, "fold -s @ -o main --exclude .scratch/");

		const children = childrenOf(cwd, "main");
		expect(children).toHaveLength(1);
		const files = jj(["file", "list", "-r", children[0]?.id ?? ""], cwd);
		expect(files).toContain("session.txt");
		expect(files).not.toContain(".scratch/ticket.md");
	}, 30_000);

	it("returns no-changes when every changed path is excluded", async () => {
		const cwd = initRepo();
		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const notifications = captureNotifications(runner);
		const sessionId = getSessionId(runner);
		const workspace = wsPath(cwd, sessionId);

		mkdirSync(join(workspace, ".scratch"), { recursive: true });
		writeFileSync(join(workspace, ".scratch", "ticket.md"), "ticket\n");
		await simulateInteraction(runner, "Session change", "Done.");

		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		execSync("jj describe -m 'feat: upstream'", { cwd, stdio: "pipe" });
		execSync("jj bookmark set main -r @", { cwd, stdio: "pipe" });

		await runSillajje(runner, "fold -s @ -o main --exclude .scratch/");

		expect(childrenOf(cwd, "main")).toHaveLength(0);
		expect(notifications).toContainEqual(
			expect.objectContaining({
				type: "info",
				msg: expect.stringContaining("nothing to fold"),
			}),
		);
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

	it("shows Progress for the replay and clears it when the fold returns", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["new", base, "-m", "upstream"], cwd);
		writeFileSync(join(cwd, "upstream.txt"), "upstream\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		jj(["new", base, "-m", "feat"], cwd);
		writeFileSync(join(cwd, "feat.txt"), "feat\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const { widgets } = captureUi(runner);

		await runSillajje(runner, "fold -r feat -o main");

		const rendered = widgets
			.map((write) => write.lines)
			.filter((lines): lines is string[] => lines !== undefined);
		expect(
			rendered.some((lines) =>
				lines.some((line) => line.includes("folding onto main")),
			),
		).toBe(true);
		expect(widgets.at(-1)?.lines).toBeUndefined();
	}, 30_000);

	it("freezes the fold step when the fold conflicts", async () => {
		const cwd = initRepo();
		const base = baseChangeId(cwd);

		jj(["new", base, "-m", "upstream"], cwd);
		writeFileSync(join(cwd, "file.txt"), "upstream\n");
		jj(["bookmark", "set", "main", "-r", "@"], cwd);

		jj(["new", base, "-m", "feat"], cwd);
		writeFileSync(join(cwd, "file.txt"), "feat\n");
		jj(["bookmark", "set", "feat", "-r", "@"], cwd);

		const runner = await createRunner(cwd);
		await runner.emit({ type: "session_start", reason: "startup" });
		const { widgets } = captureUi(runner);

		await runSillajje(runner, "fold -r feat -o main");

		expect(widgets.at(-1)?.lines).toEqual(["✗ folding onto main"]);
	}, 30_000);
});
