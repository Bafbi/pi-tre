import { readFileSync, statSync } from "node:fs";

import {
	type ExtensionAPI,
	isBashToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "@earendil-works/pi-coding-agent";

import { extractFullReadPaths } from "./bash.js";
import { requiresFullReadBeforeWrite } from "./guard.js";
import { diskMatchesInjected, extractInjectedContent } from "./injected.js";
import { resolveBashPath, resolveCanonicalPath } from "./path.js";

function getPathFromInput(input: Record<string, unknown>): string | undefined {
	const path = input.path;
	if (typeof path === "string" && path.length > 0) return path;

	const filePath = input.file_path;
	if (typeof filePath === "string" && filePath.length > 0) return filePath;

	return undefined;
}

/** A read result is a full read only when it asked for the whole file. */
function readCoversWholeFile(input: Record<string, unknown>): boolean {
	return input.offset === undefined && input.limit === undefined;
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
 * mtime on record, which fails safe (the next write is blocked and the agent
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
 * Blocks a whole-file write when the agent has not seen the file's current
 * version in full. `edit` is deliberately not gated: the edit tool re-reads
 * the file and requires every oldText to match a unique region, so its own
 * exact-match check is the freshness check for the edited region.
 *
 * The filesystem records when a file changed (mtime), but not whether the
 * agent has seen that version. A read leaves no filesystem trace, so this
 * map is the only state: canonical path -> mtime of the last full read.
 *
 * A full read is a `read` with no offset/limit and no truncation, a bare
 * `cat` with no pipe, redirect, flag, or truncated bash output, or injected
 * content whose disk file still matches. Partial readers (head, tail, sed,
 * grep, rg) and pipelines do not qualify. A successful write also records a
 * full read: after the tool result the file on disk is exactly what the agent
 * wrote.
 *
 * The before_agent_start handler records injected files only after verifying
 * the disk file still holds the injected content. The tool_result handler
 * records bash-read files, but only for commands that provably print a whole
 * file (see src/bash.ts); anything ambiguous records nothing, which fails
 * safe for the write gate.
 */
export default function (pi: ExtensionAPI) {
	const fullyReadMtimeMs = new Map<string, number>();

	const recordFullRead = (canonicalPath: string): void => {
		const mtimeMs = getFileMtimeMs(canonicalPath);
		if (mtimeMs === undefined) return;
		fullyReadMtimeMs.set(canonicalPath, mtimeMs);
	};

	pi.on("session_start", async () => {
		fullyReadMtimeMs.clear();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// Pi 1.2.0 fires this event for custom-message runs too. Those runs
		// have no user prompt, so `/skill:name` cannot have expanded; context
		// files still travel on systemPromptOptions.
		const prompt = event.messageType === "user" ? event.prompt : "";
		const injected = extractInjectedContent(
			prompt,
			event.systemPromptOptions?.contextFiles,
		);

		for (const entry of injected) {
			// resolveCanonicalPath handles absolute skill/context paths, ~, and
			// realpath for symlinked skill dirs.
			const canonicalPath = resolveCanonicalPath(entry.path, ctx.cwd);
			const disk = statThenRead(canonicalPath);
			if (disk === undefined) continue;
			if (!diskMatchesInjected(entry, disk.content)) continue;
			fullyReadMtimeMs.set(canonicalPath, disk.mtimeMs);
		}

		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("write", event)) {
			return undefined;
		}

		const toolPath = getPathFromInput(event.input);
		if (!toolPath) return undefined;

		const canonicalPath = resolveCanonicalPath(toolPath, ctx.cwd);
		const currentMtimeMs = getFileMtimeMs(canonicalPath);
		// New file writes are allowed.
		if (currentMtimeMs === undefined) return undefined;

		if (
			!requiresFullReadBeforeWrite(
				currentMtimeMs,
				fullyReadMtimeMs.get(canonicalPath),
			)
		) {
			return undefined;
		}

		const fullReadMtimeMs = fullyReadMtimeMs.get(canonicalPath);
		const reason =
			fullReadMtimeMs === undefined
				? `No full read of '${toolPath}' exists at its current version. A write replaces the whole file, and a partial read (offset/limit or truncated), a cat with flags, head/tail/sed/grep/rg, a pipe, or a path after a cd does not count. Read the whole file with the read tool (no offset/limit), or use edit for targeted changes.`
				: `'${toolPath}' changed after your last full read, so a write would replace content you have not seen. Read the whole current file with the read tool (no offset/limit), or use edit for targeted changes.`;

		return { block: true, reason };
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return undefined;

		if (isBashToolResult(event)) {
			// Only `cat` proves the whole file reached context. A truncated bash
			// result proves nothing, because the cut may fall inside any file.
			if (event.details?.truncation?.truncated === true) return undefined;

			const command = event.input.command;
			if (typeof command !== "string") return undefined;

			for (const rawPath of extractFullReadPaths(command)) {
				recordFullRead(resolveBashPath(rawPath, ctx.cwd));
			}
			return undefined;
		}

		if (isReadToolResult(event)) {
			if (!readCoversWholeFile(event.input)) return undefined;
			if (event.details?.truncation?.truncated === true) return undefined;

			const toolPath = getPathFromInput(event.input);
			if (!toolPath) return undefined;

			recordFullRead(resolveCanonicalPath(toolPath, ctx.cwd));
			return undefined;
		}

		if (isWriteToolResult(event)) {
			// The agent authored the whole file, so the written version is fully
			// known even when it had no full read before the write.
			const toolPath = getPathFromInput(event.input);
			if (!toolPath) return undefined;

			recordFullRead(resolveCanonicalPath(toolPath, ctx.cwd));
		}
		return undefined;
	});

	pi.registerCommand("stale-write-guard-dump", {
		description:
			"Dump stale-write-guard state (full reads + write decisions)",
		handler: async (_args, ctx) => {
			const lines: string[] = ["# stale-write-guard dump", ""];

			const paths = [...fullyReadMtimeMs.keys()].sort();
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
						: requiresFullReadBeforeWrite(
								currentMtimeMs,
								fullyReadMtimeMs.get(canonicalPath),
							);

				let reason: string;
				if (currentMtimeMs === undefined) {
					reason = "file missing on disk";
				} else if (shouldBlock) {
					reason = "file changed after last full read";
				} else {
					reason = "full read up to date";
				}

				lines.push(`### ${canonicalPath}`);
				lines.push(`- currentMtime: ${formatMtime(currentMtimeMs)}`);
				lines.push(
					`- fullReadMtime: ${formatMtime(fullyReadMtimeMs.get(canonicalPath))}`,
				);
				lines.push(
					`- decision: ${shouldBlock ? "BLOCK write" : "ALLOW write"}`,
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
