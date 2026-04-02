import { statSync } from "node:fs";

import {
	type ExtensionAPI,
	type ExtensionContext,
	isEditToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "@mariozechner/pi-coding-agent";

import { DEFAULT_MTIME_TOLERANCE_MS, requiresReadBeforeMutation } from "./guard.js";
import { resolveCanonicalPath } from "./path.js";
import { type FileTrackingState, FileTrackingStore } from "./state.js";

const STATUS_KEY = "stale-write-guard";
const DEBUG_WIDGET_KEY = "stale-write-guard-debug";
const MAX_DEBUG_EVENTS = 20;

type UiCtx = Pick<ExtensionContext, "hasUI" | "ui">;

function getPathFromInput(input: Record<string, unknown>): string | undefined {
	const path = input.path;
	if (typeof path === "string" && path.length > 0) return path;

	const filePath = input.file_path;
	if (typeof filePath === "string" && filePath.length > 0) return filePath;

	return undefined;
}

function getFileMtimeMs(canonicalPath: string): number | undefined {
	try {
		return statSync(canonicalPath).mtimeMs;
	} catch {
		return undefined;
	}
}

function formatMtime(mtimeMs: number | undefined): string {
	if (mtimeMs === undefined) return "-";
	return new Date(mtimeMs).toISOString();
}

function computeStateReason(currentMtimeMs: number | undefined, tracked: FileTrackingState): string {
	if (currentMtimeMs === undefined) return "file-missing-on-disk";
	if (tracked.lastReadMtimeMs === undefined) return "no-read-record";
	if (currentMtimeMs - tracked.lastReadMtimeMs <= DEFAULT_MTIME_TOLERANCE_MS) return "read-up-to-date";
	return "read-stale-file-changed-after-read";
}

function truncateForDebug(text: string, maxLength = 180): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}...`;
}

function summarizeToolError(event: {
	content: Array<{ type: string; text?: string }>;
	details: unknown;
}): string {
	const textParts = event.content
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text?.trim())
		.filter((value): value is string => Boolean(value));

	const primaryText = textParts[0];
	if (primaryText) {
		return truncateForDebug(primaryText.replace(/\s+/g, " "));
	}

	if (event.details !== undefined) {
		try {
			return truncateForDebug(JSON.stringify(event.details));
		} catch {
			return "<unserializable-details>";
		}
	}

	return "<no-error-message>";
}

/**
 * stale-write-guard
 *
 * Blocks write/edit when a file changed externally after the last agent edit,
 * unless the agent has re-read the latest file version.
 */
export default function (pi: ExtensionAPI) {
	const loadedAt = new Date().toISOString();
	const store = new FileTrackingStore();
	const debugEvents: string[] = [];
	let debugEnabled = false;

	const getDebugLines = () => {
		const tracked = store.entries().sort((a, b) => a.path.localeCompare(b.path));
		const header = [`debug: ${debugEnabled ? "ON" : "OFF"}`, `tracked files: ${tracked.length}`];
		const trackedLines = tracked.slice(0, 8).flatMap(({ path, state }) => {
			const currentMtimeMs = getFileMtimeMs(path);
			const reason = computeStateReason(currentMtimeMs, state);
			return [
				`- ${path}`,
				`  current=${formatMtime(currentMtimeMs)}`,
				`  read=${formatMtime(state.lastReadMtimeMs)} edit=${formatMtime(state.lastAgentEditMtimeMs)}`,
				`  reason=${reason}`,
			];
		});
		const eventsHeader = debugEvents.length > 0 ? ["recent events:"] : [];
		return [...header, ...trackedLines, ...eventsHeader, ...debugEvents.slice(-8)];
	};

	const syncDebugUi = (ctx: UiCtx) => {
		if (!ctx.hasUI) return;
		if (!debugEnabled) {
			ctx.ui.setWidget(DEBUG_WIDGET_KEY, undefined);
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, `debug ON, tracked files: ${store.size()}`);
		ctx.ui.setWidget(DEBUG_WIDGET_KEY, getDebugLines());
	};

	const addDebugEvent = (message: string, ctx?: UiCtx) => {
		const eventLine = `${new Date().toISOString()} ${message}`;
		debugEvents.push(eventLine);
		if (debugEvents.length > MAX_DEBUG_EVENTS) {
			debugEvents.splice(0, debugEvents.length - MAX_DEBUG_EVENTS);
		}
		if (debugEnabled && ctx) {
			syncDebugUi(ctx);
		}
	};

	const buildDebugDump = (ctx: Pick<ExtensionContext, "cwd" | "sessionManager">) => {
		const now = new Date().toISOString();
		const tracked = store.entries().sort((a, b) => a.path.localeCompare(b.path));
		const branch = ctx.sessionManager.getBranch();
		const entries = ctx.sessionManager.getEntries();
		const lines: string[] = [];

		lines.push("# stale-write-guard debug dump");
		lines.push("");
		lines.push("## runtime");
		lines.push(`- now: ${now}`);
		lines.push(`- loadedAt: ${loadedAt}`);
		lines.push(`- debugEnabled: ${debugEnabled}`);
		lines.push(`- mtimeToleranceMs: ${DEFAULT_MTIME_TOLERANCE_MS}`);
		lines.push("");
		lines.push("## session");
		lines.push(`- cwd: ${ctx.cwd}`);
		lines.push(`- sessionFile: ${ctx.sessionManager.getSessionFile() ?? "<in-memory>"}`);
		lines.push(`- leafId: ${ctx.sessionManager.getLeafId() ?? "<none>"}`);
		lines.push(`- branchEntries: ${branch.length}`);
		lines.push(`- totalEntries: ${entries.length}`);
		lines.push("");
		lines.push("## tracked-files");
		lines.push(`- count: ${tracked.length}`);
		lines.push("");

		if (tracked.length === 0) {
			lines.push("(no tracked files yet)");
		} else {
			for (const { path, state } of tracked) {
				const currentMtimeMs = getFileMtimeMs(path);
				const shouldBlock =
					currentMtimeMs === undefined
						? false
						: requiresReadBeforeMutation({
								currentMtimeMs,
								lastReadMtimeMs: state.lastReadMtimeMs,
							});
				const reason = computeStateReason(currentMtimeMs, state);

				lines.push(`### ${path}`);
				lines.push(`- currentMtime: ${formatMtime(currentMtimeMs)} (${currentMtimeMs ?? "-"})`);
				lines.push(`- lastReadMtime: ${formatMtime(state.lastReadMtimeMs)} (${state.lastReadMtimeMs ?? "-"})`);
				lines.push(
					`- lastAgentEditMtime: ${formatMtime(state.lastAgentEditMtimeMs)} (${state.lastAgentEditMtimeMs ?? "-"})`,
				);
				lines.push(`- decisionNow: ${shouldBlock ? "BLOCK write/edit" : "ALLOW write/edit"}`);
				lines.push(`- decisionReason: ${reason}`);
				lines.push("");
			}
		}

		lines.push("## recent-events");
		if (debugEvents.length === 0) {
			lines.push("(no events)");
		} else {
			for (const event of debugEvents) {
				lines.push(`- ${event}`);
			}
		}

		return `${lines.join("\n")}\n`;
	};

	pi.on("session_start", async (_event, ctx) => {
		store.clear();
		debugEvents.length = 0;
		addDebugEvent("session_start: state reset", ctx);

		if (ctx.hasUI) {
			ctx.ui.notify(`[stale-write-guard] loaded at ${loadedAt}`, "info");
			syncDebugUi(ctx);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) {
			return undefined;
		}

		const toolPath = getPathFromInput(event.input);
		if (!toolPath) {
			addDebugEvent(`tool_call:${event.toolName} path missing`, ctx);
			return undefined;
		}

		const canonicalPath = resolveCanonicalPath(toolPath, ctx.cwd);
		const currentMtimeMs = getFileMtimeMs(canonicalPath);
		if (currentMtimeMs === undefined) {
			// New file writes are allowed.
			addDebugEvent(`tool_call:${event.toolName} allow (new file): ${toolPath}`, ctx);
			return undefined;
		}

		const tracked = store.get(canonicalPath);
		const shouldBlock = requiresReadBeforeMutation({
			currentMtimeMs,
			lastReadMtimeMs: tracked?.lastReadMtimeMs,
		});
		if (!shouldBlock) {
			addDebugEvent(`tool_call:${event.toolName} allow: ${toolPath}`, ctx);
			return undefined;
		}

		addDebugEvent(`tool_call:${event.toolName} BLOCK stale file: ${toolPath}`, ctx);
		return {
			block: true,
			reason: `File '${toolPath}' has no fresh read for its current version. Read it again before mutating.`,
		};
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) {
			const toolPath = getPathFromInput(event.input);
			const pathInfo = toolPath ? ` path=${toolPath}` : "";
			const errorSummary = summarizeToolError(event);
			addDebugEvent(`tool_result:${event.toolName} ignored (error)${pathInfo} message=${errorSummary}`, ctx);
			return undefined;
		}

		const toolPath = getPathFromInput(event.input);
		if (!toolPath) return undefined;

		const canonicalPath = resolveCanonicalPath(toolPath, ctx.cwd);
		const mtimeMs = getFileMtimeMs(canonicalPath);
		if (mtimeMs === undefined) return undefined;

		if (isReadToolResult(event)) {
			store.markRead(canonicalPath, mtimeMs);
			addDebugEvent(`tool_result:read markRead ${toolPath}`, ctx);
			return undefined;
		}

		if (isWriteToolResult(event) || isEditToolResult(event)) {
			store.markAgentEdit(canonicalPath, mtimeMs);
			addDebugEvent(`tool_result:${event.toolName} markAgentEdit ${toolPath}`, ctx);
			return undefined;
		}

		return undefined;
	});

	pi.registerCommand("stale-write-guard-debug", {
		description: "Debug stale-write-guard (on|off|status|toggle|dump)",
		handler: async (args, ctx) => {
			const [subcommandRaw] = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = subcommandRaw ?? "toggle";

			switch (subcommand) {
				case "on": {
					debugEnabled = true;
					addDebugEvent("debug enabled", ctx);
					break;
				}
				case "off": {
					debugEnabled = false;
					addDebugEvent("debug disabled", ctx);
					break;
				}
				case "status": {
					addDebugEvent("debug status requested", ctx);
					break;
				}
				case "dump": {
					const report = buildDebugDump(ctx);
					addDebugEvent("debug dump generated", ctx);
					if (ctx.hasUI) {
						ctx.ui.setEditorText(report);
						ctx.ui.notify("stale-write-guard debug dump copied to editor", "info");
					}
					break;
				}
				case "toggle": {
					debugEnabled = !debugEnabled;
					addDebugEvent(`debug ${debugEnabled ? "enabled" : "disabled"} (toggle)`, ctx);
					break;
				}
				default: {
					if (ctx.hasUI) {
						ctx.ui.notify("Unknown subcommand. Use: /stale-write-guard-debug [on|off|status|toggle|dump]", "warning");
					}
					return;
				}
			}

			syncDebugUi(ctx);
			if (ctx.hasUI && subcommand !== "dump") {
				const status = debugEnabled ? "ON" : "OFF";
				ctx.ui.notify(`stale-write-guard debug: ${status}`, "info");
			}
		},
	});
}
