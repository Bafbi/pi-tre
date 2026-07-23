# 03 — Path redirection

**What to build:** The `tool_call` handler intercepts file-operation tools and redirects them to the workspace. `read`, `write`, and `edit` paths are resolved to absolute workspace paths. `bash` commands are wrapped with a `cd <workspace> &&` prefix. This ensures all agent file operations happen in the isolated workspace rather than the user's original repo. After this ticket, the agent operates entirely in the workspace — files it reads come from the workspace, files it writes land in the workspace. No changes are stamped yet.

**Blocked by:** 02 — Workspace creation and system prompt injection

**Status:** ready-for-agent

- [ ] `path-redirect.ts` module with interface: `redirectToolInput(event, workspacePath) → void` — mutates `event.input` in place
- [ ] `tool_call` handler for `read`: resolves relative `path` to absolute workspace path
- [ ] `tool_call` handler for `write`: resolves relative `path` to absolute workspace path (new files created in workspace)
- [ ] `tool_call` handler for `edit`: resolves relative `path` to absolute workspace path
- [ ] `tool_call` handler for `bash`: prepends `cd <workspace-path> && ` to `command` input
- [ ] Handler no-ops for tools not involving file paths (`web_search`, `repo_query`, `fetch_content`, `grep`)
- [ ] Handler no-ops when state is inactive
- [ ] Relative paths are preserved as relative (only the base is changed); absolute paths already inside the workspace are left untouched
- [ ] Unit tests for `path-redirect.ts`: table-driven, mock event shapes for each tool type, assert input mutations are correct
- [ ] Integration test via ExtensionRunner: fires `tool_call` for `read("src/foo.ts")` in active session, asserts `event.input.path` is rewritten to workspace absolute path
- [ ] Integration test via ExtensionRunner: fires `tool_call` for `bash("npm test")` in active session, asserts `event.input.command` is prefixed with `cd <workspace> &&`
- [ ] Integration test via ExtensionRunner: fires `tool_call` for `web_search(...)`, asserts input is unchanged (no-op for non-file tools)
