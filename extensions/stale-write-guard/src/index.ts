import { readFileSync, statSync } from "node:fs";

import {
	type ExtensionAPI,
	isEditToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "@earendil-works/pi-coding-agent";

import { requiresReadBeforeMutation } from "./guard.js";
import { diskMatchesInjected, extractInjectedContent } from "./injected.js";
import { resolveCanonicalPath } from "./path.js";

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

/**
 * Stat before read: any change landing between the two calls leaves a stale
 * mtime on record, which fails safe (the next edit is blocked and the agent
 * re-reads). Stat after read could record a newer mtime than the content the
 * agent saw, which would silently whitelist an unseen version.
 */
function statThenRead(
	path: string,
): { mtimeMs: number; content: string } | undefined {
	try {
		const mtimeMs = statSync(path).mtimeMs;
		return { mtimeMs, content: readFileSync(path, "utf-8") };
	} catch {
		return undefined;
	}
}

function formatMtime(mtimeMs: number | undefined): string {
	if (mtimeMs === undefined) return "-";
	return new Date(mtimeMs).toISOString();
}

/**
 * stale-write-guard
 *
 * Blocks write/edit when a file changed externally after the agent last
 * saw it, unless the agent has re-read the latest file version.
 *
 * The filesystem records when a file changed (mtime), but not whether the
 * agent has read that version. A read leaves no filesystem trace, so this
 * map is the only state: canonical path -> mtime the agent last saw.
 *
 * A successful write/edit also updates the map: after the tool result the
 * file on disk is exactly what the agent has in context.
 *
 * Some content reaches the context without a tool_result: `/skill:name`
 * expansion injects a skill file block into the prompt, and session-start
 * context files (AGENTS.md, CLAUDE.md) land in the system prompt. The
 * before_agent_start handler records those too, but only after verifying
 * the disk file still holds the injected content.
 */
export default function (pi: ExtensionAPI) {
	const lastSeenMtimeMs = new Map<string, number>();

	pi.on("session_start", async () => {
		lastSeenMtimeMs.clear();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const injected = extractInjectedContent(
			event.prompt,
			event.systemPromptOptions?.contextFiles,
		);

		for (const entry of injected) {
			// resolveCanonicalPath handles absolute skill/context paths, ~, and
			// realpath for symlinked skill dirs.
			const canonicalPath = resolveCanonicalPath(entry.path, ctx.cwd);
			const disk = statThenRead(canonicalPath);
			if (disk === undefined) continue;
			if (!diskMatchesInjected(entry, disk.content)) continue;
			lastSeenMtimeMs.set(canonicalPath, disk.mtimeMs);
		}

		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (
			!isToolCallEventType("write", event) &&
			!isToolCallEventType("edit", event)
		) {
			return undefined;
		}

		const toolPath = getPathFromInput(event.input);
		if (!toolPath) return undefined;

		const canonicalPath = resolveCanonicalPath(toolPath, ctx.cwd);
		const currentMtimeMs = getFileMtimeMs(canonicalPath);
		// New file writes are allowed.
		if (currentMtimeMs === undefined) return undefined;

		if (
			!requiresReadBeforeMutation(
				currentMtimeMs,
				lastSeenMtimeMs.get(canonicalPath),
			)
		) {
			return undefined;
		}

		return {
			block: true,
			reason: `File '${toolPath}' has no fresh read for its current version. Read it again before mutating.`,
		};
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return undefined;

		const isTrackedTool =
			isReadToolResult(event) ||
			isWriteToolResult(event) ||
			isEditToolResult(event);
		if (!isTrackedTool) return undefined;

		const toolPath = getPathFromInput(event.input);
		if (!toolPath) return undefined;

		const canonicalPath = resolveCanonicalPath(toolPath, ctx.cwd);
		const mtimeMs = getFileMtimeMs(canonicalPath);
		if (mtimeMs === undefined) return undefined;

		lastSeenMtimeMs.set(canonicalPath, mtimeMs);
		return undefined;
	});

	pi.registerCommand("stale-write-guard-dump", {
		description: "Dump stale-write-guard state (tracked files + decisions)",
		handler: async (_args, ctx) => {
			const lines: string[] = ["# stale-write-guard dump", ""];

			const paths = [...lastSeenMtimeMs.keys()].sort();
			lines.push(`tracked files: ${paths.length}`);
			lines.push("");

			if (paths.length === 0) {
				lines.push("(no tracked files yet)");
			}

			for (const canonicalPath of paths) {
				const currentMtimeMs = getFileMtimeMs(canonicalPath);
				const shouldBlock =
					currentMtimeMs === undefined
						? false
						: requiresReadBeforeMutation(
								currentMtimeMs,
								lastSeenMtimeMs.get(canonicalPath),
							);

				let reason: string;
				if (currentMtimeMs === undefined) {
					reason = "file missing on disk";
				} else if (lastSeenMtimeMs.get(canonicalPath) === undefined) {
					reason = "no read record";
				} else if (shouldBlock) {
					reason = "file changed after last read";
				} else {
					reason = "read up to date";
				}

				lines.push(`### ${canonicalPath}`);
				lines.push(`- currentMtime: ${formatMtime(currentMtimeMs)}`);
				lines.push(
					`- lastSeenMtime: ${formatMtime(lastSeenMtimeMs.get(canonicalPath))}`,
				);
				lines.push(
					`- decision: ${shouldBlock ? "BLOCK write/edit" : "ALLOW write/edit"}`,
				);
				lines.push(`- reason: ${reason}`);
				lines.push("");
			}

			if (ctx.hasUI) {
				ctx.ui.setEditorText(`${lines.join("\n")}\n`);
			}
		},
	});
}
