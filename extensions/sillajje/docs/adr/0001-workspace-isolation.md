# Workspace isolation via separate jj workspaces + path redirection

Pi extensions cannot change `ctx.cwd` — it's a getter backed by a private field set once at runtime construction. To isolate each Pi session's working tree from the user's main checkout and from other sessions, we use jj workspaces in a dedicated directory (`~/.pi/sillajje/`) and redirect all agent file operations there via system prompt injection and `tool_call` path rewriting.

## Considered Options

**Path A (chosen): separate jj workspaces.** Each session gets its own jj workspace checkout at `~/.pi/sillajje/<repo>/<session-id>/`. The agent's file operations are redirected there. Full isolation, clean slate per session, no risk of cross-session contamination. Costs: setup per session (`pnpm install` etc.), path redirection complexity, no gitignored files in the workspace.

**Path B (rejected): colocated — work in the user's repo.** No jj workspaces, no path redirection. The extension creates jj changes directly in the repo's directory. Simpler code, no setup overhead. Rejected because: it offers no isolation between concurrent sessions, session state bleeds into the user's working tree, and it violates the principle that an agent session should leave the user's repo untouched until explicitly merged.

## Consequences

- Workspace directories live at `~/.pi/sillajje/<repo>/<session-id>/`. Disk usage scales with session count; archiving deletes directories to reclaim space.
- Every agent file operation incurs path redirection: `read`/`write`/`edit` get absolute workspace paths, `bash` gets a `cd <workspace> &&` prefix.
- Gitignored files are absent from workspaces. Repos must be reproducible via mise + setup scripts.
- jj bookmarks (`sillajje/<session-id>`) remain the stable handles on session work independent of workspace directory state.
