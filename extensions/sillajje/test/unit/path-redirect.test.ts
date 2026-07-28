import { describe, expect, it } from "vitest";
import { redirect } from "../../src/path-redirect";

const WS = "/home/user/.pi/sillajje/my-repo/abc123";
const REPO = "/home/user/my-repo";

function makeEvent(toolName: string, input: Record<string, unknown>) {
	return { type: "tool_call" as const, toolCallId: "id-1", toolName, input };
}

describe("redirect", () => {
	// -----------------------------------------------------------------------
	// read
	// -----------------------------------------------------------------------
	it("resolves relative read path against workspace", () => {
		const event = makeEvent("read", { path: "src/foo.ts" });
		const info = redirect(event as any, WS);
		expect(event.input.path).toBe(`${WS}/src/foo.ts`);
		expect(info.wasRewritten).toBe(true);
		expect(info.originalPath).toBe("src/foo.ts");
	});

	it("detects absolute path inside repo and reports repoRelativePath", () => {
		const event = makeEvent("read", {
			path: "/home/user/my-repo/src/bar.ts",
		});
		const info = redirect(event as any, WS, REPO);
		// Not remapped — caller blocks with a hint.
		expect(event.input.path).toBe("/home/user/my-repo/src/bar.ts");
		expect(info.wasRewritten).toBe(false);
		expect(info.originalPath).toBe("/home/user/my-repo/src/bar.ts");
		expect(info.repoRelativePath).toBe("src/bar.ts");
	});

	it("leaves absolute path outside repo untouched and reports it", () => {
		const event = makeEvent("read", { path: "/etc/config.ini" });
		const info = redirect(event as any, WS, REPO);
		expect(event.input.path).toBe("/etc/config.ini");
		expect(info.wasRewritten).toBe(false);
		expect(info.originalPath).toBe("/etc/config.ini");
	});

	it("leaves empty read path untouched", () => {
		const event = makeEvent("read", { path: "" });
		const info = redirect(event as any, WS);
		expect(event.input.path).toBe("");
		expect(info.wasRewritten).toBe(false);
	});

	it("leaves workspace-absolute read path untouched (already inside WS)", () => {
		const path = `${WS}/src/bar.ts`;
		const event = makeEvent("read", { path });
		const info = redirect(event as any, WS, REPO);
		expect(event.input.path).toBe(path);
		expect(info.wasRewritten).toBe(false);
	});

	// -----------------------------------------------------------------------
	// write
	// -----------------------------------------------------------------------
	it("resolves relative write path against workspace", () => {
		const event = makeEvent("write", {
			path: "src/new.ts",
			content: "hello",
		});
		redirect(event as any, WS);
		expect(event.input.path).toBe(`${WS}/src/new.ts`);
	});

	it("detects absolute write path inside repo with repoRelativePath", () => {
		const event = makeEvent("write", {
			path: "/home/user/my-repo/out.txt",
			content: "x",
		});
		const info = redirect(event as any, WS, REPO);
		expect(event.input.path).toBe("/home/user/my-repo/out.txt");
		expect(info.wasRewritten).toBe(false);
		expect(info.repoRelativePath).toBe("out.txt");
	});

	// -----------------------------------------------------------------------
	// edit
	// -----------------------------------------------------------------------
	it("resolves relative edit path against workspace", () => {
		const event = makeEvent("edit", {
			path: "src/mod.ts",
			edits: [{ oldText: "a", newText: "b" }],
		});
		redirect(event as any, WS);
		expect(event.input.path).toBe(`${WS}/src/mod.ts`);
	});

	// -----------------------------------------------------------------------
	// bash
	// -----------------------------------------------------------------------
	it("prepends cd <workspace> && to bash command", () => {
		const event = makeEvent("bash", { command: "npm test" });
		const info = redirect(event as any, WS);
		expect(event.input.command).toBe(`cd ${WS} && npm test`);
		expect(info.wasRewritten).toBe(true);
	});

	it("handles bash commands with existing cd", () => {
		const event = makeEvent("bash", { command: "cd /tmp && ls" });
		redirect(event as any, WS);
		expect(event.input.command).toBe(`cd ${WS} && cd /tmp && ls`);
	});

	// -----------------------------------------------------------------------
	// no-ops
	// -----------------------------------------------------------------------
	it("no-ops for grep", () => {
		const event = makeEvent("grep", { pattern: "TODO", path: "." });
		const info = redirect(event as any, WS);
		expect(event.input.path).toBe(".");
		expect(info.wasRewritten).toBe(false);
	});

	it("no-ops for find", () => {
		const event = makeEvent("find", { pattern: "*.ts", path: "src" });
		redirect(event as any, WS);
		expect(event.input.path).toBe("src");
	});

	it("no-ops for ls", () => {
		const event = makeEvent("ls", { path: "src" });
		redirect(event as any, WS);
		expect(event.input.path).toBe("src");
	});

	it("no-ops for unknown tools", () => {
		const event = makeEvent("web_search", { query: "hello" });
		const info = redirect(event as any, WS);
		expect(event.input).toEqual({ query: "hello" });
		expect(info.wasRewritten).toBe(false);
	});
});
