/**
 * Arguments for the `/sillajje rebase|fold <rev>` subcommands.
 *
 * `rev` is the positional target revision; `sessionId` targets a non-current
 * sillajje session. When `sessionId` is absent the command operates on the
 * current session.
 */
export interface RebaseFoldArgs {
	rev: string;
	sessionId?: string;
}

/**
 * Parse the args string of the `/sillajje rebase|fold <rev>` subcommands.
 *
 * Pure and deterministic — unit-tested in isolation.
 *
 * Rules:
 * - Tokens are whitespace-delimited; leading/trailing whitespace is trimmed
 *   and empty tokens are dropped.
 * - `rev` is the first token that does not start with `-` (the first
 *   positional token). Extra positional tokens are ignored.
 * - `--session <id>` sets `sessionId`. The flag and value are separate
 *   tokens; when `--session` is repeated, the last occurrence wins.
 * - Unknown flags (any token starting with `-`) are ignored.
 * - A trailing `--session` with no value token is ignored.
 *
 * Returns `{ rev: "" }` when there is no positional token (empty args or
 * flags only) — callers treat an empty rev as a usage error.
 */
export function parseRebaseFoldArgs(args: string): RebaseFoldArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const result: RebaseFoldArgs = { rev: "" };

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--session") {
			const value = tokens[i + 1];
			if (value !== undefined) {
				result.sessionId = value;
				i += 1; // consume the value token
			}
			continue;
		}
		if (token.startsWith("-")) continue; // unknown flag — ignore
		if (result.rev === "") result.rev = token;
	}

	return result;
}
