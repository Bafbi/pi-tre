import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { copyToClipboard, type ExtensionContext } from "@mariozechner/pi-coding-agent";

import { formatMessage } from "./formatter.js";

function isMessageEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> {
	return entry.type === "message";
}

export async function handleCopyLeaf(ctx: ExtensionContext): Promise<void> {
	try {
		const editorText = ctx.ui.getEditorText();
		if (editorText.trim() !== "") {
			await copyToClipboard(editorText);
			if (ctx.hasUI) ctx.ui.notify("Copied editor text to clipboard", "info");
			return;
		}

		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (!isMessageEntry(entry)) continue;

			const role = entry.message.role;
			if (role !== "user" && role !== "assistant") continue;

			const text = formatMessage(entry.message);
			if (text !== null) {
				await copyToClipboard(text);
				if (ctx.hasUI) ctx.ui.notify("Copied leaf text to clipboard", "info");
				return;
			}
		}

		if (ctx.hasUI) ctx.ui.notify("Nothing to copy", "warning");
	} catch (err) {
		if (ctx.hasUI) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Copy failed: ${message}`, "error");
		}
	}
}
