/**
 * Recognize bash commands that put a whole file into the agent's context.
 *
 * The goal is narrow: find the file paths a command prints in full, so the
 * guard can record a full read for them. Only `cat` qualifies. A partial
 * reader (head, tail, sed, grep, rg) or a pipeline does not prove the agent
 * saw the whole file, and a wrong record would whitelist a stale write.
 */

/** Commands whose stdout is the complete file content. */
const FULL_FILE_READERS = new Set(["cat"]);

/** Operators that change what the agent sees (pipes, redirects, backgrounding). */
const UNSAFE_CHARS = /[|<>&]/;

/** Substitutions and variable expansions make path extraction unreliable. */
const UNSAFE_EXPANSION_CHARS = /[$`]/;

/** Split a compound command into its sequential segments. */
const SEGMENT_SPLIT = /&&|\|\||;|\n/;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Commands that change the shell's working directory. */
const DIRECTORY_CHANGE_COMMANDS = new Set(["cd", "pushd", "popd"]);

/** Wrappers that keep the next token as the command name. */
const COMMAND_PREFIXES = new Set(["command", "builtin", "exec", "time"]);

/**
 * Tokenize one command segment, honoring quotes and backslash escapes.
 * Returns undefined for unterminated quotes.
 */
function tokenize(segment: string): string[] | undefined {
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;

	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i] ?? "";
		if (quote !== undefined) {
			if (ch === quote) {
				quote = undefined;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "\\") {
			i++;
			if (i >= segment.length) return undefined;
			current += segment.charAt(i);
			continue;
		}
		if (/\s/.test(ch)) {
			if (current !== "") tokens.push(current);
			current = "";
			continue;
		}
		current += ch;
	}

	if (quote !== undefined) return undefined;
	if (current !== "") tokens.push(current);
	return tokens;
}

/** Extract candidate file paths from one simple command segment. */
function segmentPaths(segment: string): string[] {
	if (UNSAFE_CHARS.test(segment)) return [];
	if (UNSAFE_EXPANSION_CHARS.test(segment)) return [];

	const tokens = tokenize(segment);
	if (!tokens || tokens.length === 0) return [];

	// Skip environment assignments: FOO=1 cat file
	let index = 0;
	while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index] ?? ""))
		index++;
	if (index >= tokens.length) return [];

	const command = tokens[index];
	if (command === undefined) return [];
	index++;

	if (FULL_FILE_READERS.has(command)) {
		const operands = tokens.slice(index);
		// A flag changes the view (`-s` drops lines, `-n`/`-A` rewrite them)
		// or adds options. Only a bare `cat file` proves the whole content.
		if (operands.some((token) => token.startsWith("-"))) return [];
		return operands;
	}
	return [];
}

/**
 * True when a segment changes the working directory. Once the directory is
 * unknown, the guard cannot resolve a later relative path against the session
 * cwd, so it records nothing after that point.
 */
function isDirectoryChange(segment: string): boolean {
	const tokens = tokenize(segment);
	if (!tokens || tokens.length === 0) return false;

	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		if (
			ENV_ASSIGNMENT.test(token) ||
			COMMAND_PREFIXES.has(token) ||
			/^[({!]+$/.test(token)
		) {
			index++;
			continue;
		}
		break;
	}

	const command = tokens[index]?.replace(/^[({!]+/, "");
	return command !== undefined && DIRECTORY_CHANGE_COMMANDS.has(command);
}

/**
 * Return the file paths a bash command prints in full, or an empty list when
 * the command is partial, transformed, or too complex to analyze safely.
 * Non-existing candidates are filtered out later, when the caller stats them.
 *
 * A `cd`/`pushd`/`popd` segment makes every later relative path ambiguous, so
 * paths after it are dropped. A `cat` before the directory change still
 * counts.
 */
export function extractFullReadPaths(command: string): string[] {
	const paths: string[] = [];
	let directoryChanged = false;

	for (const rawSegment of command.split(SEGMENT_SPLIT)) {
		const segment = rawSegment.trim();
		if (isDirectoryChange(segment)) {
			directoryChanged = true;
			continue;
		}
		if (directoryChanged) continue;
		paths.push(...segmentPaths(segment));
	}
	return paths;
}
