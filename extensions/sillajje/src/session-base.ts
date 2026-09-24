/**
 * The Base a `/sillajje:new` invocation hands to the session it creates.
 *
 * The command cannot pass a value to the session it creates: `ctx.newSession`
 * rebinds extensions, so `session_start` runs in a fresh instance with fresh
 * state. The command therefore writes the chosen base into the new session's
 * log during `ctx.newSession`'s `setup`, and `session_start` reads it back.
 * The entry also records the base in the session file for later review.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CommandHelp, CommandSpec } from "@pi-tre/sillajje-core";

/** The custom type of the Base marker entry. */
export const SESSION_BASE_TYPE = "sillajje/base";

/** The data a Base marker carries. */
export interface SessionBaseMarker {
	/** The revision the new session's workspace branches from. */
	base: string;
	/** The token the user named, for messages. */
	label: string;
}

/**
 * The newest Base marker on the branch, or undefined when the branch has none.
 * A branch has no marker for a plain pi `/new`, which branches from `trunk()`.
 */
export function lastSessionBase(
	branch: SessionEntry[],
): SessionBaseMarker | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (
			entry?.type !== "custom" ||
			entry.customType !== SESSION_BASE_TYPE
		) {
			continue;
		}
		const data = entry.data;
		if (data === null || typeof data !== "object") continue;
		const base = (data as { base?: unknown }).base;
		if (typeof base !== "string") continue;
		const label = (data as { label?: unknown }).label;
		return { base, label: typeof label === "string" ? label : base };
	}
	return undefined;
}

/** The `/sillajje:new` subcommand's flags. */
export const NEW_ARGS: CommandSpec = {
	name: "new",
	usage: "new [-o|--onto <rev>] [-s|--onto-session <id>]",
	flags: [
		{ key: "onto", aliases: ["-o", "--onto"], takesValue: true },
		{
			key: "onto-session",
			aliases: ["-s", "--onto-session"],
			takesValue: true,
		},
	],
	exclusive: [["onto", "onto-session"]],
};

/** The `/sillajje:new` subcommand's help. */
export const NEW_HELP: CommandHelp = {
	usage: NEW_ARGS.usage,
	lines: [
		"Starts a new pi session whose workspace branches from a base, not trunk().",
		"A bare invocation branches from trunk(), the same as pi's /new.",
		"  -o, --onto <rev>         branch from a revision; @ means this workspace's working copy",
		"  -s, --onto-session <id>  branch from a session's bookmark; @ means this session",
		"  -h, --help               show this help",
	],
};
