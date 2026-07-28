# 08 — Post-init commands

**What to build:** After workspace creation, the extension runs a configurable list of shell commands synchronously. This lets the workspace auto-install dependencies (`pnpm install`, `mise install`, etc.) before the agent starts working.

Configuration via `.pi/configs/sillajje.json`:

```json
{
  "postInit": ["pnpm install", "mise install"]
}
```

Override via `SILLAJJE_POST_INIT` environment variable (`;` as separator):

```bash
SILLAJJE_POST_INIT="pnpm install; mise install" pi
```

**Blocked by:** None — can start immediately. Workspace creation (issue 02) and config system (config.ts) are already in place.

**Status:** ready-for-agent

## Design

- Commands run sequentially after `createWorkspace()` succeeds in `session_start`
- Blocks `session_start` until all commands complete
- Each command's start/completion/error shown via `ctx.ui.notify`
- Errors are non-fatal — the session activates regardless, but the user knows something failed
- Commands should be idempotent (install commands are); they run on every `session_start`, not just on first creation

## Tasks

- [ ] Add `postInit: string[]` field to `SillajjeConfig` interface in `config.ts`
- [ ] Add `SILLAJJE_POST_INIT` env var parsing in `config.ts` (split on `;`)
- [ ] Env var takes precedence over config file
- [ ] In `session_start` handler, after workspace creation: iterate `postInit` commands
- [ ] Run each command via `pi.exec(cmd, [], { cwd: workspacePath })` or shell execution
- [ ] Wrap in try/catch, notify on each failure, continue to next command
- [ ] Show progress notification: `[sillajje] running post-init: pnpm install...`
- [ ] Show success notification: `[sillajje] post-init complete`
- [ ] Show error notification on failure: `[sillajje] post-init command failed: ...`
- [ ] Unit tests for `config.ts`: postInit field loading, env var parsing, precedence
- [ ] Integration test: session_start runs post-init commands, success/error notifications fire
- [ ] Integration test: commands run from workspace directory (create a file, assert it exists in workspace)
