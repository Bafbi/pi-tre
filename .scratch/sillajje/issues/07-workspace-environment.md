# 07 — Workspace environment

**What to build:** Three tightly-related UX improvements that make the workspace feel right when you land in it:

1. **Switch workspace base from `@` to `@-`** — sessions start from the last stable commit, with `@` as fallback when `@-` doesn't exist.
2. **Update system prompt** — the `before_agent_start` workspace block explains that gitignored files are absent and dependencies may need installing.
3. **Intercept `user_bash` for `!`/`!!` commands** — `!` and `!!` commands currently run from `ctx.cwd` (the original repo). Intercept via `pi.on("user_bash", ...)` and redirect execution to the workspace directory using `createLocalBashOperations()`.

**Blocked by:** 02 — Workspace creation (complete). The workspace must exist before any of these apply.

**Status:** ready-for-agent

## Tasks

### 7a — Workspace base revision

- [ ] In `workspace.ts`, change `createWorkspace` to use `@-` instead of `@`: `jj workspace add --name <name> --revision @- <path>`
- [ ] Fall back to `@` when `@-` doesn't exist (e.g. first commit in repo) — detect via `jj log -r @-` exit code before workspace creation
- [ ] Unit test: verify correct `--revision` flag is passed for both cases
- [ ] Integration test: workspace created from `@-` exists and is a valid checkout

### 7b — System prompt education

- [ ] Update the workspace block in `before_agent_start` handler to explain:
  - This is a clean checkout — gitignored files (node_modules, etc.) are absent
  - This is normal
  - Install dependencies using whatever method the repo recommends
  - Use relative paths; absolute paths pointing at the original repo will be blocked
- [ ] Integration test: system prompt contains the explanatory text about missing deps

### 7c — `user_bash` interception

- [ ] Import `createLocalBashOperations` from `@earendil-works/pi-coding-agent`
- [ ] Register `pi.on("user_bash", ...)` handler in `index.ts`
- [ ] When active: wrap `createLocalBashOperations()` and override `cwd` with workspace path
- [ ] When inactive: pass through (return `undefined`)
- [ ] Unit test: mocked `user_bash` event, assert workspace cwd override
- [ ] Integration test: `!pwd` in active session returns workspace path; `!pwd` in inactive session returns original cwd
