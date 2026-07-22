import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		copyToClipboard: vi.fn(),
	};
});

import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { handleCopyLeaf } from "../../src/copy-leaf.js";

function createMockContext(
	overrides: {
		editorText?: string;
		branch?: Array<{
			type: string;
			message: { role: string; content: unknown };
		}>;
		hasUI?: boolean;
	} = {},
) {
	const notify = vi.fn();
	return {
		ui: {
			getEditorText: () => overrides.editorText ?? "",
			notify,
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			pasteToEditor: () => {},
			setEditorText: () => {},
			editor: async () => undefined,
			setEditorComponent: () => {},
			get theme() {
				return {} as any;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		} satisfies Record<string, unknown>,
		hasUI: overrides.hasUI ?? true,
		cwd: "/tmp",
		sessionManager: {
			getBranch: () =>
				(overrides.branch ?? []).map((b, i) => ({
					type: b.type,
					id: String(i + 1),
					parentId: i === 0 ? null : String(i),
					timestamp: "2024-01-01T00:00:00.000Z",
					message: b.message,
				})),
		} as any,
		modelRegistry: {} as any,
		model: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("handleCopyLeaf", () => {
	it("copies editor text when editor is not empty", async () => {
		const ctx = createMockContext({ editorText: "  draft code  " });
		await handleCopyLeaf(ctx as any);

		expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(
			"  draft code  ",
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Copied editor text to clipboard",
			"info",
		);
	});

	it("walks back to last user message with text", async () => {
		const ctx = createMockContext({
			branch: [
				{
					type: "message",
					message: { role: "user", content: "first" },
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "reply" }],
					},
				},
			],
		});
		await handleCopyLeaf(ctx as any);

		expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith("reply");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Copied leaf text to clipboard",
			"info",
		);
	});

	it("skips tool results and walks back further", async () => {
		const ctx = createMockContext({
			branch: [
				{ type: "message", message: { role: "user", content: "q" } },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "a" }],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						content: [{ type: "text", text: "tool" }],
					},
				},
			],
		});
		await handleCopyLeaf(ctx as any);

		expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith("a");
	});

	it("skips bash executions", async () => {
		const ctx = createMockContext({
			branch: [
				{ type: "message", message: { role: "user", content: "cmd" } },
				{
					type: "bashExecution",
					message: {
						role: "bashExecution",
						command: "ls",
						output: "file",
					},
				},
			],
		});
		await handleCopyLeaf(ctx as any);

		expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith("cmd");
	});

	it("warns when nothing is copyable", async () => {
		const ctx = createMockContext({ branch: [] });
		await handleCopyLeaf(ctx as any);

		expect(copyToClipboard).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Nothing to copy",
			"warning",
		);
	});

	it("warns when branch has only non-text entries", async () => {
		const ctx = createMockContext({
			branch: [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "thinking", thinking: "..." }],
					},
				},
			],
		});
		await handleCopyLeaf(ctx as any);

		expect(copyToClipboard).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Nothing to copy",
			"warning",
		);
	});

	it("silently fails in non-interactive mode on error", async () => {
		vi.mocked(copyToClipboard).mockRejectedValueOnce(
			new Error("clipboard broken"),
		);
		const ctx = createMockContext({
			editorText: "text",
			hasUI: false,
		});
		await expect(handleCopyLeaf(ctx as any)).resolves.toBeUndefined();
		expect(copyToClipboard).toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("notifies error in interactive mode when copy fails", async () => {
		vi.mocked(copyToClipboard).mockRejectedValueOnce(
			new Error("clipboard broken"),
		);
		const ctx = createMockContext({ editorText: "text" });
		await handleCopyLeaf(ctx as any);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Copy failed: clipboard broken",
			"error",
		);
	});
});
