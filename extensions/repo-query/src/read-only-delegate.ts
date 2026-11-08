/**
 * Read-only guard for pi delegates.
 *
 * A delegate is declared read-only by its thread title. T3 sets the child
 * session name to that title, so the child reads it with
 * `ctx.sessionManager.getSessionName()`. Once the title starts with
 * `read-only:`, a `tool_call` hook allows only the read-only tools and blocks
 * everything else. pi runs the same hook for nested calls made by a codemode
 * script, so `tools.write`, `tools.edit`, `tools.bash`, and T3 control tools
 * are blocked inside codemode too.
 *
 * This applies to pi delegates. A delegate on another provider does not load
 * this extension, so it is not covered.
 */

/** A delegate whose title starts with this prefix is read-only. */
export const READ_ONLY_DELEGATE_TITLE_PREFIX = "read-only:";

/**
 * The only tools a read-only delegate may call.
 *
 * `codemode` is allowed because its nested calls still pass through this
 * hook. `tool_search` only lists tools, it does not call them.
 */
const READ_ONLY_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"codemode",
	"tool_search",
]);

/** True when a delegate title declares it read-only. */
export function isReadOnlyDelegateTitle(
	title: string | null | undefined,
): boolean {
	return (
		typeof title === "string" &&
		title.trimStart().startsWith(READ_ONLY_DELEGATE_TITLE_PREFIX)
	);
}

/** The block response for a tool outside the allowlist, or undefined. */
export function readOnlyDelegateToolBlock(
	toolName: string,
): { block: true; reason: string } | undefined {
	if (READ_ONLY_ALLOWED_TOOLS.has(toolName)) return undefined;
	return {
		block: true,
		reason: `Read-only pi delegates may not call ${toolName}.`,
	};
}
