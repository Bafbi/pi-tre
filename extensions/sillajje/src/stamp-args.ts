/**
 * Arguments for the `/sillajje stamp` subcommand.
 *
 * A stamp takes no positionals and requires one target: `--rev <rev>` for a
 * Rev stamp, `--session <id>` for a Session stamp. `--session @` names the
 * current session. With no target the command prints help.
 */
export interface StampArgs {
	/** Target revision for a Rev stamp (`--rev` / `-r`). */
	rev?: string;
	/**
	 * Target session for a Session stamp (`--session` / `-s`). The value `@`
	 * means the current session.
	 */
	sessionId?: string;
	/**
	 * True when the caller asked for help or named no target. The command
	 * prints help and does nothing else.
	 */
	help?: boolean;
	/**
	 * Usage error message when the args are invalid: `--rev` and
	 * `--session` together, a flag missing its value, or a stray
	 * positional. The message names the command form. When set, the
	 * caller must not stamp.
	 */
	error?: string;
}

const USAGE = "usage: /sillajje stamp [-r|--rev <rev>] [-s|--session <id>]";

/** Help text shown by `-h`, `--help`, and a target-less `/sillajje stamp`. */
export const STAMP_HELP = [
	USAGE,
	"",
	"Seals a change with a generated commit message. Exactly one target is required:",
	"  -r, --rev <rev>     describe the revision; no bookmark, no new change",
	"  -s, --session <id>  seal a session's working copy; @ means this session",
	"  -h, --help          show this help",
].join("\n");

/**
 * Parse the args string of the `/sillajje stamp` subcommand.
 *
 * Pure and deterministic — unit-tested in isolation.
 *
 * Rules:
 * - Tokens are whitespace-delimited; leading/trailing whitespace is trimmed
 *   and empty tokens are dropped.
 * - `--help` or `-h` anywhere returns help. Help wins over every other rule,
 *   including a missing flag value and the mutual-exclusion error.
 * - Empty args return help: a stamp requires a target.
 * - `--rev <rev>` / `-r <rev>` sets `rev`. Repeated, the last occurrence wins.
 * - `--session <id>` / `-s <id>` sets `sessionId`; the value `@` means the
 *   current session. Repeated, the last occurrence wins.
 * - Setting both `rev` and `sessionId` is an error.
 * - `--rev`, `-r`, `--session`, or `-s` without a following value token is
 *   an error.
 * - Unknown flags (any other token starting with `-`) are ignored.
 * - Any token that is not a flag or a flag value is an unexpected positional
 *   and an error (the stamp subcommand takes no positionals).
 */
export function parseStampArgs(args: string): StampArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);

	// Help wins over every other flag, valid or not.
	if (tokens.some((t) => t === "-h" || t === "--help")) {
		return { help: true };
	}
	if (tokens.length === 0) {
		return { help: true };
	}

	const result: StampArgs = {};
	const set = (key: "rev" | "sessionId", value: string) => {
		result[key] = value;
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--rev" || token === "-r") {
			const value = tokens[i + 1];
			if (value === undefined) {
				return {
					error: `${USAGE} (--rev requires a value)`,
				};
			}
			set("rev", value);
			i += 1; // consume the value token
			continue;
		}
		if (token === "--session" || token === "-s") {
			const value = tokens[i + 1];
			if (value === undefined) {
				return {
					error: `${USAGE} (--session requires a value)`,
				};
			}
			set("sessionId", value);
			i += 1; // consume the value token
			continue;
		}
		if (token.startsWith("-")) continue; // unknown flag — ignore
		return {
			error: `${USAGE} (unexpected argument "${token}")`,
		};
	}

	if (result.rev !== undefined && result.sessionId !== undefined) {
		return {
			error: `${USAGE} — --rev and --session are mutually exclusive`,
		};
	}

	return result;
}
