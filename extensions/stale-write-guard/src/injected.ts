/**
 * File content the agent holds in context without a read tool call.
 *
 * Pi injects file content through paths that never emit a tool_result:
 * - `/skill:name` expansion (agent-session `_expandSkillCommand`) injects a
 *   `<skill name="..." location="...">` block into the prompt.
 * - Session-start context files (AGENTS.md, AGENTS.override.md, CLAUDE.md)
 *   land in the system prompt via `systemPromptOptions.contextFiles`.
 *
 * The guard must treat this content as "seen" or it blocks edits of files
 * the agent demonstrably has in context.
 */
export interface InjectedContent {
	/** How the content reached the context. */
	kind: "skill" | "context";
	/** File the content came from, as pi reports it. */
	path: string;
	/** Content the agent holds in context. */
	content: string;
}

/**
 * Matches pi's `_expandSkillCommand` block format:
 * `<skill name="..." location="...">\n<references line>\n\n<body>\n</skill>`.
 * If pi changes the format, parsing fails and the guard records nothing —
 * the agent then just re-reads the file (safe, only friction).
 */
const SKILL_BLOCK_PATTERN =
	/<skill\s+name="[^"\n]*"\s+location="([^"\n]+)">\n[\s\S]*?\n<\/skill>/g;

/**
 * Extract the file content injected into a prompt by `/skill:name` expansion,
 * plus context files carried in `systemPromptOptions.contextFiles`.
 */
export function extractInjectedContent(
	prompt: string,
	contextFiles: ReadonlyArray<{ path: string; content: string }> | undefined,
): InjectedContent[] {
	const injected: InjectedContent[] = [];

	for (const match of prompt.matchAll(SKILL_BLOCK_PATTERN)) {
		const [block, location] = match;
		const body = extractSkillBody(block);
		if (body === undefined) continue;
		injected.push({ kind: "skill", path: location, content: body });
	}

	for (const file of contextFiles ?? []) {
		if (typeof file.path !== "string" || typeof file.content !== "string") {
			continue;
		}
		injected.push({
			kind: "context",
			path: file.path,
			content: file.content,
		});
	}

	return injected;
}

/**
 * The block body sits after the header lines: the opening tag line, a
 * "References are relative to ..." line, and the blank line between them.
 */
function extractSkillBody(block: string): string | undefined {
	const separator = block.indexOf("\n\n");
	if (separator === -1) return undefined;
	const body = block.slice(separator + 2).replace(/\n<\/skill>$/, "");
	if (body.length === 0) return undefined;
	return body;
}

/**
 * True when the file on disk still holds the content the agent saw.
 *
 * Skill bodies are frontmatter-stripped and trimmed by pi's expansion, so
 * the same normalization applies to the disk content. Context files are
 * BOM-stripped by the resource loader.
 */
export function diskMatchesInjected(
	injection: InjectedContent,
	diskContent: string,
): boolean {
	if (injection.kind === "context") {
		return stripBom(diskContent) === injection.content;
	}
	return stripFrontmatter(diskContent).trim() === injection.content;
}

/** Mirrors pi's stripFrontmatter: only strips a leading `---` fenced block. */
function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return content;
	const afterFence = content.indexOf("\n", end + 1);
	return afterFence === -1 ? "" : content.slice(afterFence + 1);
}

/** Mirrors pi's stripBom for resource file content. */
function stripBom(content: string): string {
	return content.startsWith("\uFEFF") ? content.slice(1) : content;
}
