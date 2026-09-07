import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "repo-query";
const DEBUG_WIDGET_KEY = "repo-query-debug";
const MAX_DEBUG_EVENTS = 20;

type UiCtx = Pick<ExtensionContext, "hasUI" | "ui">;

export interface DebugState {
	enabled: boolean;
	events: string[];
	workspacePath: string | null;
	trackedRepos: Map<
		string,
		{ status: string; cloned: boolean; branch?: string | null }
	>;
}

export function createDebugState(): DebugState {
	return {
		enabled: false,
		events: [],
		workspacePath: null,
		trackedRepos: new Map(),
	};
}

export function addDebugEvent(
	state: DebugState,
	message: string,
	ctx?: UiCtx,
): void {
	const eventLine = `${new Date().toISOString()} ${message}`;
	state.events.push(eventLine);
	if (state.events.length > MAX_DEBUG_EVENTS) {
		state.events.splice(0, state.events.length - MAX_DEBUG_EVENTS);
	}
	if (state.enabled && ctx) {
		syncDebugUi(state, ctx);
	}
}

export function setDebugEnabled(
	state: DebugState,
	enabled: boolean,
	ctx?: UiCtx,
): void {
	state.enabled = enabled;
	if (ctx) syncDebugUi(state, ctx);
}

export function trackRepo(
	state: DebugState,
	identifier: string,
	info: { status: string; cloned: boolean; branch?: string | null },
): void {
	state.trackedRepos.set(identifier, info);
}

export function setWorkspacePath(state: DebugState, path: string): void {
	state.workspacePath = path;
}

/** Register the /repo-query-debug command on the extension API. */
export function registerDebugCommand(
	pi: ExtensionAPI,
	debug: DebugState,
): void {
	pi.registerCommand("repo-query-debug", {
		description: "Debug repo-query (on|off|status|toggle|dump)",
		handler: async (args, ctx) => {
			const [subcommandRaw] = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = subcommandRaw ?? "toggle";

			switch (subcommand) {
				case "on": {
					setDebugEnabled(debug, true, ctx);
					addDebugEvent(debug, "debug enabled", ctx);
					break;
				}
				case "off": {
					setDebugEnabled(debug, false, ctx);
					addDebugEvent(debug, "debug disabled", ctx);
					break;
				}
				case "status": {
					addDebugEvent(debug, "debug status requested", ctx);
					break;
				}
				case "dump": {
					const report = buildDebugDump(debug, ctx);
					addDebugEvent(debug, "debug dump generated", ctx);
					if (ctx.hasUI) {
						ctx.ui.setEditorText(report);
						ctx.ui.notify(
							"repo-query debug dump copied to editor",
							"info",
						);
					}
					break;
				}
				case "toggle": {
					setDebugEnabled(debug, !debug.enabled, ctx);
					addDebugEvent(
						debug,
						`debug ${debug.enabled ? "enabled" : "disabled"} (toggle)`,
						ctx,
					);
					break;
				}
				default: {
					if (ctx.hasUI) {
						ctx.ui.notify(
							"Unknown subcommand. Use: /repo-query-debug [on|off|status|toggle|dump]",
							"warning",
						);
					}
					return;
				}
			}

			if (ctx.hasUI && subcommand !== "dump") {
				const status = debug.enabled ? "ON" : "OFF";
				ctx.ui.notify(`repo-query debug: ${status}`, "info");
			}
		},
	});
}

export function syncDebugUi(state: DebugState, ctx: UiCtx): void {
	if (!ctx.hasUI) return;
	if (!state.enabled) {
		ctx.ui.setWidget(DEBUG_WIDGET_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const lines = getDebugLines(state);
	ctx.ui.setStatus(
		STATUS_KEY,
		`repo-query debug ON, repos: ${state.trackedRepos.size}`,
	);
	ctx.ui.setWidget(DEBUG_WIDGET_KEY, lines);
}

function getDebugLines(state: DebugState): string[] {
	const header = [
		`debug: ${state.enabled ? "ON" : "OFF"}`,
		`workspace: ${state.workspacePath ?? "<none>"}`,
		`tracked repos: ${state.trackedRepos.size}`,
	];

	const repoLines: string[] = [];
	if (state.trackedRepos.size > 0) {
		for (const [id, info] of state.trackedRepos) {
			repoLines.push(
				`- ${id}: ${info.status}${info.cloned ? " (cloned)" : ""}${info.branch ? ` [${info.branch}]` : ""}`,
			);
		}
	}

	const eventsHeader = state.events.length > 0 ? ["recent events:"] : [];
	return [
		...header,
		"",
		...repoLines,
		...eventsHeader,
		...state.events.slice(-8),
	];
}

export function buildDebugDump(
	state: DebugState,
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
): string {
	const now = new Date().toISOString();
	const branch = ctx.sessionManager.getBranch();
	const entries = ctx.sessionManager.getEntries();
	const lines: string[] = [];

	lines.push("# repo-query debug dump");
	lines.push("");
	lines.push("## runtime");
	lines.push(`- now: ${now}`);
	lines.push(`- debugEnabled: ${state.enabled}`);
	lines.push(`- workspacePath: ${state.workspacePath ?? "<none>"}`);
	lines.push("");
	lines.push("## session");
	lines.push(`- cwd: ${ctx.cwd}`);
	lines.push(
		`- sessionFile: ${ctx.sessionManager.getSessionFile() ?? "<in-memory>"}`,
	);
	lines.push(`- leafId: ${ctx.sessionManager.getLeafId() ?? "<none>"}`);
	lines.push(`- branchEntries: ${branch.length}`);
	lines.push(`- totalEntries: ${entries.length}`);
	lines.push("");
	lines.push("## tracked-repos");
	lines.push(`- count: ${state.trackedRepos.size}`);
	lines.push("");

	if (state.trackedRepos.size === 0) {
		lines.push("(no tracked repos yet)");
	} else {
		for (const [id, info] of state.trackedRepos) {
			lines.push(`### ${id}`);
			lines.push(`- status: ${info.status}`);
			lines.push(`- cloned: ${info.cloned}`);
			if (info.branch) lines.push(`- branch: ${info.branch}`);
			lines.push("");
		}
	}

	lines.push("## recent-events");
	if (state.events.length === 0) {
		lines.push("(no events)");
	} else {
		for (const event of state.events) {
			lines.push(`- ${event}`);
		}
	}

	return `${lines.join("\n")}\n`;
}
