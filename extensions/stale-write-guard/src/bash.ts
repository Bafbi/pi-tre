/**
 * Recognize bash commands that put file content into the agent's context.
 *
 * The goal is narrow: find the file paths a command prints, so the guard
 * can record a read for them. When in doubt, record nothing — a missing
 * record only causes an extra read, while a wrong record would whitelist
 * a stale write.
 */

/** Commands whose stdout is the file content itself. */
const WHOLE_FILE_READERS = new Set(["cat", "head", "tail", "tac", "nl", "bat"]);

/**
 * Commands whose first non-flag operand is a pattern and whose remaining
 * operands are files. Their output shows only matching lines, so this
 * counts as seeing those lines, not the whole file.
 */
const PATTERN_READERS = new Set(["grep", "rg"]);

/** Operators that change what the agent sees (pipes, redirects, backgrounding). */
const UNSAFE_CHARS = /[|<>&]/;

/** Substitutions and variable expansions make path extraction unreliable. */
const UNSAFE_EXPANSION_CHARS = /[$`]/;

/** Split a compound command into its sequential segments. */
const SEGMENT_SPLIT = /&&|\|\||;|\n/;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

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

	if (WHOLE_FILE_READERS.has(command)) {
		return tokens.slice(index).filter((token) => !token.startsWith("-"));
	}
	if (PATTERN_READERS.has(command)) {
		const operands = tokens
			.slice(index)
			.filter((token) => !token.startsWith("-"));
		// The first operand is the pattern, not a file.
		return operands.slice(1);
	}
	return [];
}

/**
 * Return the file paths a bash command prints, or an empty list when the
 * command does not put file content into context (or is too complex to
 * analyze safely). Non-existing candidates are filtered out later, when
 * the caller stats them.
 */
export function extractReadPaths(command: string): string[] {
	const paths: string[] = [];
	for (const segment of command.split(SEGMENT_SPLIT)) {
		paths.push(...segmentPaths(segment.trim()));
	}
	return paths;
}
