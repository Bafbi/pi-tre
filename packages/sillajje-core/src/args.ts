/**
 * Shared command-line argument rules.
 *
 * One parser, one help convention, one session-error renderer, shared by
 * every subcommand. The rules are data: a `CommandSpec` names the flags a
 * subcommand accepts, which are required, and which cannot appear together.
 * The parser is pure, so an action can own its input validation without an
 * adapter.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Why a session target failed to resolve. Shared with the workspace port. */
export type SessionFailure = "not-a-session" | "foreign" | "archived";

/** A flag a subcommand accepts. */
export interface FlagDef {
	/** The key the parsed value is stored under. */
	key: string;
	/** Every token that selects this flag, e.g. `["-r", "--rev"]`. */
	aliases: readonly string[];
	/** Whether the flag consumes the following token as its value. */
	takesValue: boolean;
}

/** A subcommand's argument rules. */
export interface CommandSpec {
	/** The subcommand name, e.g. `stamp`. */
	name: string;
	/** The usage line, shown by help and repeated in every usage error. */
	usage: string;
	/** Every flag the subcommand accepts. */
	flags: readonly FlagDef[];
	/** Keys that must be present. */
	required?: readonly string[];
	/** Key pairs that cannot appear together. */
	exclusive?: readonly (readonly [string, string])[];
}

export type ArgValue = string | boolean;

export type ParseResult =
	| { kind: "go"; values: Record<string, ArgValue> }
	| { kind: "help" }
	| { kind: "error"; message: string };

/** A subcommand's help text. */
export interface CommandHelp {
	/** The usage line, normally `CommandSpec.usage`. */
	usage: string;
	/** Lines shown after the usage line and a blank line. */
	lines: readonly string[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** The long-form name of a key, for messages: `--rev`. */
function flagLabel(spec: CommandSpec, key: string): string {
	const flag = spec.flags.find((f) => f.key === key);
	if (flag === undefined) return key;
	return flag.aliases[flag.aliases.length - 1] ?? key;
}

/**
 * Parse a subcommand's args string against its spec.
 *
 * Rules:
 * - Tokens are whitespace-delimited; leading and trailing whitespace is
 *   trimmed and empty tokens are dropped.
 * - `skip` drops leading tokens first. The adapter passes `{ skip: 1 }` to
 *   drop the `/sillajje <subcommand>` token, so the parser owns the whole
 *   tokenizing step and the command text is never split twice.
 * - `-h`, `--help`, and a target-less invocation (no tokens) return help.
 *   Help wins over every other rule, including a missing flag value.
 * - A flag's value is the following token, even when it starts with `-`.
 * - A repeated flag keeps its last value.
 * - An unknown flag, a flag missing its value, a stray positional, a missing
 *   required flag, and a mutually exclusive pair are errors.
 */
export function parseCommandArgs(
	args: string,
	spec: CommandSpec,
	options?: { skip?: number },
): ParseResult {
	const tokens = args
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.slice(options?.skip ?? 0);

	if (tokens.some((t) => t === "-h" || t === "--help"))
		return { kind: "help" };
	if (tokens.length === 0) return { kind: "help" };

	const values: Record<string, ArgValue> = {};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === undefined) continue;
		const flag = spec.flags.find((f) => f.aliases.includes(token));
		if (flag === undefined) {
			return {
				kind: "error",
				message: token.startsWith("-")
					? `${spec.usage} (unknown flag "${token}")`
					: `${spec.usage} (unexpected argument "${token}")`,
			};
		}
		if (!flag.takesValue) {
			values[flag.key] = true;
			continue;
		}
		const value = tokens[i + 1];
		if (value === undefined) {
			return {
				kind: "error",
				message: `${spec.usage} (${token} requires a value)`,
			};
		}
		values[flag.key] = value;
		i += 1;
	}

	for (const [a, b] of spec.exclusive ?? []) {
		if (values[a] !== undefined && values[b] !== undefined) {
			return {
				kind: "error",
				message: `${spec.usage} — ${flagLabel(spec, a)} and ${flagLabel(spec, b)} are mutually exclusive`,
			};
		}
	}

	for (const key of spec.required ?? []) {
		if (values[key] === undefined) {
			return {
				kind: "error",
				message: `${spec.usage} (missing ${flagLabel(spec, key)})`,
			};
		}
	}

	return { kind: "go", values };
}

// ---------------------------------------------------------------------------
// Help and session errors
// ---------------------------------------------------------------------------

/** Render a subcommand's help text: the usage line, a blank line, then lines. */
export function renderHelp(help: CommandHelp): string {
	return [help.usage, "", ...help.lines].join("\n");
}

/**
 * The human message for a failed session-target resolution. One home for the
 * three negative reasons.
 */
export function renderSessionFailure(
	reason: SessionFailure,
	key: string,
): string {
	if (reason === "not-a-session") {
		return `session ${key} is not a sillajje session — no sillajje bookmark`;
	}
	if (reason === "foreign") {
		return `session ${key} belongs to another owner — it cannot be used here`;
	}
	return `session ${key} is archived — unarchive it first`;
}

// ---------------------------------------------------------------------------
// The stamp subcommand
// ---------------------------------------------------------------------------

/** `/sillajje stamp` — one target, a revision or a session. */
export const STAMP_ARGS: CommandSpec = {
	name: "stamp",
	usage: "usage: /sillajje stamp [-r|--rev <rev>] [-s|--session <id>]",
	flags: [
		{ key: "rev", aliases: ["-r", "--rev"], takesValue: true },
		{ key: "session", aliases: ["-s", "--session"], takesValue: true },
	],
	exclusive: [["rev", "session"]],
};

/** `/sillajje stamp` help. */
export const STAMP_HELP: CommandHelp = {
	usage: STAMP_ARGS.usage,
	lines: [
		"Seals a change with a generated commit message. Exactly one target is required:",
		"  -r, --rev <rev>     describe the revision; no bookmark, no new change",
		"  -s, --session <id>  seal a session's working copy; @ means this session",
		"  -h, --help          show this help",
	],
};
