/**
 * Read-only guard for repo_query delegates.
 *
 * A delegate task carries a marker in its prompt. The extension scans the
 * session branch for that marker; once found, a `tool_call` hook allows only
 * the read-only tools and blocks everything else. pi runs the same hook for
 * nested calls made by a codemode script, so `tools.write`, `tools.edit`,
 * `tools.bash`, and T3 control tools are blocked inside codemode too.
 *
 * This applies to pi delegates. A delegate on another provider does not load
 * this extension, so it is not covered.
 */

/** Prefix shared by every delegate task marker. */
export const DELEGATE_MARKER_PREFIX = "REPO_QUERY_DELEGATE_V1:";

/**
 * The only tools a repo_query delegate may call.
 *
 * `codemode` is allowed because its nested calls still pass through this
 * hook. `tool_search` only lists tools, it does not call them.
 */
const DELEGATE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"codemode",
	"tool_search",
]);

interface BranchEntryLike {
	type?: unknown;
	message?: {
		role?: unknown;
		content?: unknown;
	};
}

/** True when a user message in the branch carries the delegate marker. */
export function branchHasDelegateMarker(
	branch: readonly BranchEntryLike[],
): boolean {
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "user") continue;
		if (contentHasMarker(message.content)) return true;
	}
	return false;
}

function contentHasMarker(content: unknown): boolean {
	if (typeof content === "string") {
		return content.includes(DELEGATE_MARKER_PREFIX);
	}
	if (!Array.isArray(content)) return false;
	return content.some((part) => {
		if (typeof part !== "object" || part === null) return false;
		const record = part as Record<string, unknown>;
		return (
			record.type === "text" &&
			typeof record.text === "string" &&
			record.text.includes(DELEGATE_MARKER_PREFIX)
		);
	});
}

/** The block response for a tool outside the allowlist, or undefined. */
export function delegateToolBlock(
	toolName: string,
): { block: true; reason: string } | undefined {
	if (DELEGATE_ALLOWED_TOOLS.has(toolName)) return undefined;
	return {
		block: true,
		reason: `repo_query delegates are read-only. ${toolName} is blocked.`,
	};
}
