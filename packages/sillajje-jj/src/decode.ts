/**
 * Decode jj's `json(self)` output into the typed domain shapes.
 *
 * A parse or shape failure throws `JjError({ kind: "decode" })` naming the
 * field and the raw line, so a jj output change surfaces as a test failure
 * rather than a silent `undefined`.
 */

import { JjError } from "./errors.js";
import type { Bookmark, Commit } from "./types.js";

type Raw = Record<string, unknown>;

function splitLines(output: string): string[] {
	return output.split("\n").filter((line) => line.trim().length > 0);
}

function parseObject(what: string, line: string): Raw {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new JjError({ kind: "decode", what, raw: line });
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new JjError({ kind: "decode", what, raw: line });
	}
	return value as Raw;
}

function readString(
	raw: Raw,
	field: string,
	what: string,
	line: string,
): string {
	const value = raw[field];
	if (typeof value !== "string") {
		throw new JjError({ kind: "decode", what, raw: line });
	}
	return value;
}

function readStringArray(
	raw: Raw,
	field: string,
	what: string,
	line: string,
): string[] {
	const value = raw[field];
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
		throw new JjError({ kind: "decode", what, raw: line });
	}
	return value as string[];
}

export function decodeCommits(output: string): Commit[] {
	return splitLines(output).map((line) => {
		const raw = parseObject("commit", line);
		return {
			commitId: readString(raw, "commit_id", "commit.commit_id", line),
			changeId: readString(raw, "change_id", "commit.change_id", line),
			parents: readStringArray(raw, "parents", "commit.parents", line),
			description: readString(
				raw,
				"description",
				"commit.description",
				line,
			),
		};
	});
}

export function decodeBookmarks(output: string): Bookmark[] {
	return splitLines(output).map((line) => {
		const raw = parseObject("bookmark", line);
		// A remote-tracking bookmark carries `remote` and a possibly-null
		// target; only local targets are strings.
		const target = Array.isArray(raw.target)
			? raw.target.filter(
					(value): value is string => typeof value === "string",
				)
			: [];
		const bookmark: Bookmark = {
			name: readString(raw, "name", "bookmark.name", line),
			target,
		};
		if (typeof raw.remote === "string") bookmark.remote = raw.remote;
		return bookmark;
	});
}

/** Parse `name:root` lines. The first colon separates name from path. */
export function decodeWorkspaces(
	output: string,
): { name: string; root: string }[] {
	const workspaces: { name: string; root: string }[] = [];
	for (const line of splitLines(output)) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const name = line.slice(0, colon).trim();
		const root = line.slice(colon + 1).trim();
		if (name.length === 0 || root.length === 0) continue;
		workspaces.push({ name, root });
	}
	return workspaces;
}
