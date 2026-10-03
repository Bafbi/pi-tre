import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { beforeEach, expect, it } from "vitest";
import {
	createRunner,
	describeJj,
	getSessionId,
	initRepo,
	installDefaultSubGeneratorMock,
	runSillajje,
	wsPath,
} from "./_helpers.js";

interface CapturedUi {
	notifications: Array<{ msg: string; type: "info" | "warning" | "error" }>;
	statuses: Map<string, string | undefined>;
}

/** Replace the runner's UI with capture surfaces for notifications and status. */
function captureUi(runner: ExtensionRunner): CapturedUi {
	const notifications: CapturedUi["notifications"] = [];
	const statuses = new Map<string, string | undefined>();
	runner.setUIContext(
		{
			setStatus: (key: string, text: string | undefined) => {
				statuses.set(key, text);
			},
			setWidget: () => {},
			notify: (msg: string, type: "info" | "warning" | "error") =>
				notifications.push({ msg, type }),
			setEditorText: () => {},
			getEditorText: () => "",
		} as unknown as Parameters<typeof runner.setUIContext>[0],
		"tui",
	);
	return { notifications, statuses };
}

/** Every `http://localhost:<port>` URL mentioned in a notification. */
function localhostUrls(ui: CapturedUi): string[] {
	const urls: string[] = [];
	for (const entry of ui.notifications) {
		for (const match of entry.msg.matchAll(/http:\/\/localhost:\d+/g)) {
			urls.push(match[0]);
		}
	}
	return urls;
}

async function setup(cwd: string): Promise<{
	runner: ExtensionRunner;
	sessionId: string;
	root: string;
	ui: CapturedUi;
}> {
	const runner = await createRunner(cwd);
	await runner.emit({ type: "session_start", reason: "startup" });
	const ui = captureUi(runner);
	const sessionId = getSessionId(runner);
	return { runner, sessionId, root: wsPath(cwd, sessionId), ui };
}

beforeEach(() => {
	installDefaultSubGeneratorMock();
});

describeJj("sillajje serve", () => {
	it("serves the workspace and sets the footer indicator", async () => {
		const { runner, root, ui } = await setup(initRepo());
		writeFileSync(join(root, "report.html"), "<h1>hi</h1>");

		try {
			await runSillajje(runner, "serve");
			expect(ui.statuses.get("sillajje-serve")).toMatch(/^serve: /);

			const [url] = localhostUrls(ui);
			expect(url).toBeDefined();
			const res = await fetch(`${url}/report.html`);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe("<h1>hi</h1>");
		} finally {
			await runSillajje(runner, "serve --stop");
		}
	});

	it("reports the live URL for --status and clears it for --stop", async () => {
		const { runner, ui } = await setup(initRepo());

		try {
			await runSillajje(runner, "serve");
			const [url] = localhostUrls(ui);
			expect(url).toBeDefined();

			ui.notifications.length = 0;
			await runSillajje(runner, "serve --status");
			expect(ui.notifications.map((n) => n.msg).join("\n")).toContain(
				url ?? "",
			);

			await runSillajje(runner, "serve --stop");
			expect(ui.statuses.get("sillajje-serve")).toBeUndefined();
		} finally {
			await runSillajje(runner, "serve --stop");
		}
	});

	it("reports the live URL on a second invocation without switching", async () => {
		const { runner, ui } = await setup(initRepo());

		try {
			await runSillajje(runner, "serve");
			const [first] = localhostUrls(ui);
			expect(first).toBeDefined();

			ui.notifications.length = 0;
			await runSillajje(runner, "serve");
			const [second] = localhostUrls(ui);
			expect(second).toBe(first);
			expect(ui.notifications.map((n) => n.msg).join("\n")).toContain(
				"already serving",
			);
		} finally {
			await runSillajje(runner, "serve --stop");
		}
	});

	it("rejects a target other than @", async () => {
		const { runner, ui } = await setup(initRepo());
		await runSillajje(runner, "serve -s other");
		expect(ui.statuses.get("sillajje-serve")).toBeUndefined();
		expect(ui.notifications.some((n) => n.type === "warning")).toBe(true);
	});

	it("accepts an explicit -s @", async () => {
		const { runner, ui } = await setup(initRepo());
		try {
			await runSillajje(runner, "serve -s @");
			expect(ui.statuses.get("sillajje-serve")).toMatch(/^serve: /);
		} finally {
			await runSillajje(runner, "serve --stop");
		}
	});

	it("clears a stale serve indicator on session_start", async () => {
		const runner = await createRunner(initRepo());
		const ui = captureUi(runner);
		ui.statuses.set("sillajje-serve", "serve: http://localhost:1");
		await runner.emit({ type: "session_start", reason: "startup" });
		expect(ui.statuses.get("sillajje-serve")).toBeUndefined();
	});

	it("stops the server when the served session is archived", async () => {
		const { runner, root, ui } = await setup(initRepo());
		writeFileSync(join(root, "report.html"), "<h1>hi</h1>");

		await runSillajje(runner, "serve");
		const [url] = localhostUrls(ui);
		expect(url).toBeDefined();

		await runSillajje(runner, "archive");
		expect(ui.statuses.get("sillajje-serve")).toBeUndefined();
		await expect(fetch(`${url}/report.html`)).rejects.toThrow();
	});
});
