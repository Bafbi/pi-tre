# 03 — Path redirection

**What to build:** The `tool_call` handler intercepts file-operation tools and redirects them to the workspace. `read`, `write`, and `edit` paths are resolved to absolute workspace paths. `bash` commands are wrapped with a `cd <workspace> &&` prefix. This ensures all agent file operations happen in the isolated workspace rather than the user's original repo. After this ticket, the agent operates entirely in the workspace — files it reads come from the workspace, files it writes land in the workspace. No changes are stamped yet.

**Blocked by:** 02 — Workspace creation and system prompt injection

**Status:** complete

**Implementation notes:**
- Interface is `redirect(event, workspacePath, repoRoot?) → RedirectInfo` (returns metadata, mutates `event.input` in place)
- Additionally blocks absolute paths that point back into the original repo — returns `repoRelativePath` hint for the caller to produce a blocking reason

- [x] `path-redirect.ts` module with typed `RedirectInfo` return
- [x] `tool_call` handler for `read`: resolves relative `path` to absolute workspace path
- [x] `tool_call` handler for `write`: resolves relative `path` to absolute workspace path (new files created in workspace)
- [x] `tool_call` handler for `edit`: resolves relative `path` to absolute workspace path
- [x] `tool_call` handler for `bash`: prepends `cd <workspace-path> && ` to `command` input
- [x] Handler no-ops for tools not involving file paths (`web_search`, `repo_query`, `fetch_content`, `grep`)
- [x] Handler no-ops when state is inactive
- [x] Relative paths are resolved against workspace; absolute paths outside repo are left untouched; absolute paths inside repo are detected and blocked
- [x] Unit tests for `path-redirect.ts`: table-driven, mock event shapes for each tool type, assert input mutations are correct
- [x] Integration test via ExtensionRunner: fires `tool_call` for `read("src/foo.ts")` in active session, asserts `event.input.path` is rewritten to workspace absolute path
- [x] Integration test via ExtensionRunner: fires `tool_call` for `bash("npm test")` in active session, asserts `event.input.command` is prefixed with `cd <workspace> &&`
- [x] Integration test via ExtensionRunner: fires `tool_call` for `web_search(...)`, asserts input is unchanged (no-op for non-file tools)
