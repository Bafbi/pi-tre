import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { WebfetchMode } from "./types.js";

const STATUS_KEY = "webfetch-tool";
const DEBUG_WIDGET_KEY = "webfetch-tool-debug";
const MAX_DEBUG_EVENTS = 20;

type UiCtx = Pick<ExtensionContext, "hasUI" | "ui">;

export interface WebfetchDebugSnapshot {
	url: string;
	mode: WebfetchMode;
	statusCode: number;
	contentType: string;
	bodyBytes: number;
	conversionModelConfigured?: string;
	conversionModelUsed?: string;
	conversionPreprocessStrategy?: string;
	conversionInputCharsRaw?: number;
	conversionInputCharsPrepared?: number;
	usedSubagent: boolean;
	fallbackReason?: string;
	scanScore: number;
	scanDecision: string;
}

export interface WebfetchDebugController {
	registerCommand(): void;
	addEvent(message: string, ctx?: UiCtx): void;
	setSnapshot(snapshot: WebfetchDebugSnapshot | undefined, ctx?: UiCtx): void;
}

export function createWebfetchDebugController(pi: ExtensionAPI): WebfetchDebugController {
	let debugEnabled = false;
	const debugEvents: string[] = [];
	let lastSnapshot: WebfetchDebugSnapshot | undefined;

	const getDebugLines = () => {
		const lines: string[] = [];
		lines.push(`debug: ${debugEnabled ? "ON" : "OFF"}`);
		if (lastSnapshot) {
			lines.push(`last url: ${lastSnapshot.url}`);
			lines.push(`last mode: ${lastSnapshot.mode}`);
			lines.push(`last status/type: ${lastSnapshot.statusCode} ${lastSnapshot.contentType || "unknown"}`);
			lines.push(
				`last conversion: used=${lastSnapshot.conversionModelUsed ?? "<none>"} subagent=${lastSnapshot.usedSubagent} input=${lastSnapshot.conversionInputCharsPrepared ?? 0}/${lastSnapshot.conversionInputCharsRaw ?? 0} (${lastSnapshot.conversionPreprocessStrategy ?? "n/a"})`,
			);
			if (lastSnapshot.fallbackReason) {
				lines.push(`last fallback: ${lastSnapshot.fallbackReason}`);
			}
			lines.push(`last scan: ${lastSnapshot.scanScore} (${lastSnapshot.scanDecision})`);
		}
		if (debugEvents.length > 0) {
			lines.push("recent events:");
			for (const event of debugEvents.slice(-8)) {
				lines.push(event);
			}
		}
		return lines;
	};

	const syncDebugUi = (ctx: UiCtx) => {
		if (!ctx.hasUI) return;
		if (!debugEnabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(DEBUG_WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, "webfetch debug ON");
		ctx.ui.setWidget(DEBUG_WIDGET_KEY, getDebugLines());
	};

	const addEvent = (message: string, ctx?: UiCtx) => {
		const line = `${new Date().toISOString()} ${message}`;
		debugEvents.push(line);
		if (debugEvents.length > MAX_DEBUG_EVENTS) {
			debugEvents.splice(0, debugEvents.length - MAX_DEBUG_EVENTS);
		}
		if (debugEnabled && ctx) {
			syncDebugUi(ctx);
		}
	};

	const buildDebugDump = () => {
		const lines: string[] = [];
		lines.push("# webfetch-tool debug dump");
		lines.push("");
		lines.push(`debugEnabled: ${debugEnabled}`);
		if (lastSnapshot) {
			lines.push("");
			lines.push("## last-run");
			lines.push(`- url: ${lastSnapshot.url}`);
			lines.push(`- mode: ${lastSnapshot.mode}`);
			lines.push(`- statusCode: ${lastSnapshot.statusCode}`);
			lines.push(`- contentType: ${lastSnapshot.contentType || "unknown"}`);
			lines.push(`- bodyBytes: ${lastSnapshot.bodyBytes}`);
			lines.push(`- conversionModelConfigured: ${lastSnapshot.conversionModelConfigured ?? "<none>"}`);
			lines.push(`- conversionModelUsed: ${lastSnapshot.conversionModelUsed ?? "<none>"}`);
			lines.push(`- conversionPreprocessStrategy: ${lastSnapshot.conversionPreprocessStrategy ?? "<none>"}`);
			lines.push(`- conversionInputCharsRaw: ${lastSnapshot.conversionInputCharsRaw ?? 0}`);
			lines.push(`- conversionInputCharsPrepared: ${lastSnapshot.conversionInputCharsPrepared ?? 0}`);
			lines.push(`- usedSubagent: ${lastSnapshot.usedSubagent}`);
			lines.push(`- fallbackReason: ${lastSnapshot.fallbackReason ?? "<none>"}`);
			lines.push(`- scan: ${lastSnapshot.scanScore} (${lastSnapshot.scanDecision})`);
		}
		lines.push("");
		lines.push("## recent-events");
		if (debugEvents.length === 0) {
			lines.push("(none)");
		} else {
			for (const event of debugEvents) lines.push(`- ${event}`);
		}
		return `${lines.join("\n")}\n`;
	};

	const setSnapshot = (snapshot: WebfetchDebugSnapshot | undefined, ctx?: UiCtx) => {
		lastSnapshot = snapshot;
		if (debugEnabled && ctx) {
			syncDebugUi(ctx);
		}
	};

	const registerCommand = () => {
		pi.registerCommand("webfetch-debug", {
			description: "Debug webfetch-tool (on|off|status|toggle|dump)",
			handler: async (args, ctx) => {
				const [subcommandRaw] = args.trim().split(/\s+/).filter(Boolean);
				const subcommand = subcommandRaw ?? "toggle";

				switch (subcommand) {
					case "on": {
						debugEnabled = true;
						addEvent("debug enabled", ctx);
						break;
					}
					case "off": {
						debugEnabled = false;
						addEvent("debug disabled", ctx);
						break;
					}
					case "status": {
						addEvent("debug status requested", ctx);
						break;
					}
					case "toggle": {
						debugEnabled = !debugEnabled;
						addEvent(`debug ${debugEnabled ? "enabled" : "disabled"} (toggle)`, ctx);
						break;
					}
					case "dump": {
						addEvent("debug dump generated", ctx);
						if (ctx.hasUI) {
							ctx.ui.setEditorText(buildDebugDump());
							ctx.ui.notify("webfetch debug dump copied to editor", "info");
						}
						break;
					}
					default: {
						if (ctx.hasUI) {
							ctx.ui.notify("Unknown subcommand. Use: /webfetch-debug [on|off|status|toggle|dump]", "warning");
						}
						return;
					}
				}

				syncDebugUi(ctx);
				if (ctx.hasUI && subcommand !== "dump") {
					ctx.ui.notify(`webfetch debug: ${debugEnabled ? "ON" : "OFF"}`, "info");
				}
			},
		});
	};

	return {
		registerCommand,
		addEvent,
		setSnapshot,
	};
}
