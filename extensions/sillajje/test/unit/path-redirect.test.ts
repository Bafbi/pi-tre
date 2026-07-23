import { describe, expect, it } from "vitest";
import { redirect } from "../../src/path-redirect";

const WS = "/home/user/.pi/sillajje/my-repo/abc123";

function makeEvent(toolName: string, input: Record<string, unknown>) {
	return { type: "tool_call" as const, toolCallId: "id-1", toolName, input };
}

describe("redirect", () => {
	// -----------------------------------------------------------------------
	// read
	// -----------------------------------------------------------------------
	it("resolves relative read path against workspace", () => {
		const event = makeEvent("read", { path: "src/foo.ts" });
		redirect(event as any, WS);
		expect(event.input.path).toBe(`${WS}/src/foo.ts`);
	});

	it("leaves absolute read path untouched", () => {
		const event = makeEvent("read", { path: "/etc/config.ini" });
		redirect(event as any, WS);
		expect(event.input.path).toBe("/etc/config.ini");
	});

	it("leaves empty read path untouched", () => {
		const event = makeEvent("read", { path: "" });
		redirect(event as any, WS);
		expect(event.input.path).toBe("");
	});

	it("leaves workspace-absolute read path untouched", () => {
		const path = `${WS}/src/bar.ts`;
		const event = makeEvent("read", { path });
		redirect(event as any, WS);
		expect(event.input.path).toBe(path);
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

	it("leaves absolute write path untouched", () => {
		const event = makeEvent("write", {
			path: "/tmp/out.txt",
			content: "x",
		});
		redirect(event as any, WS);
		expect(event.input.path).toBe("/tmp/out.txt");
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
		redirect(event as any, WS);
		expect(event.input.command).toBe(`cd ${WS} && npm test`);
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
		redirect(event as any, WS);
		expect(event.input.path).toBe(".");
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
		redirect(event as any, WS);
		expect(event.input).toEqual({ query: "hello" });
	});
});
