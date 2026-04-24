# AGENTS.md (local: leaf-copy)

## Extension purpose

Copy the last text-bearing leaf of the current session branch to the clipboard.

When the editor is empty, the extension walks backwards from the session leaf
to find the most recent `user` or `assistant` message that contains text,
formats it as bare markdown, and copies it via `copyToClipboard()`.

When the editor has text, that text is copied instead.

## Design principles

- **Editor-first**: if the user has typed something, copy that.
- **Bare output**: no role headers, no tool wrappers, just the text.
- **Silent in non-interactive mode**: never throw or log in print/RPC mode.
- **Stateless**: compute on shortcut; no incremental tracking.

## Structure

- `src/formatter.ts`: pure formatting logic (`formatMessage`)
- `src/copy-leaf.ts`: shortcut handler (`handleCopyLeaf`)
- `src/index.ts`: extension factory, registers `ctrl+shift+c`

## Behavior

### Editor text path

If `ctx.ui.getEditorText().trim() !== ""` → copy that text directly.

### Walk-back path

Iterate `ctx.sessionManager.getBranch()` in reverse.
Skip entries that are:
- not `SessionMessageEntry`
- `toolResult`, `bashExecution`, `custom`, `branchSummary`, `compactionSummary`
- `user` or `assistant` with no text content (e.g. image-only)

First match → `formatMessage()` → `copyToClipboard()`.

### Notifications

- success → `ctx.ui.notify("Copied ... to clipboard", "success")`
- nothing found → `ctx.ui.notify("Nothing to copy", "warning")`
- error → `ctx.ui.notify("Copy failed: ...", "error")`

All notifications gated by `ctx.hasUI`.

## Text formatting

- User messages: string content used as-is; image blocks emit `[image]`
- Assistant messages: only `TextContent` blocks; `ThinkingContent` and `ToolCall` dropped
- Multiple text blocks joined with `\n~~~\n`
