# 07 — Workspace environment

**What to build:** Three tightly-related UX improvements that make the workspace feel right when you land in it:

1. **Switch workspace base from `@` to `@-`** — sessions start from the last stable commit, with `@` as fallback when `@-` doesn't exist.
2. **Update system prompt** — the `before_agent_start` workspace block explains that gitignored files are absent and dependencies may need installing.
3. **Intercept `user_bash` for `!`/`!!` commands** — `!` and `!!` commands currently run from `ctx.cwd` (the original repo). Intercept via `pi.on("user_bash", ...)` and redirect execution to the workspace directory using `createLocalBashOperations()`.

**Blocked by:** 02 — Workspace creation (complete). The workspace must exist before any of these apply.

**Status:** complete

## Tasks

### 7a — Workspace base revision

- [x] In `workspace.ts`, change `createWorkspace` to use `@-` instead of `@`: `jj workspace add --name <name> --revision @- <path>`
- [x] Fall back to `@` when `@-` doesn't exist (e.g. first commit in repo) — detect via `jj log -r @-` exit code before workspace creation
- [x] Unit test: verify correct `--revision` flag is passed for both cases
- [x] Integration test: workspace created from `@-` exists and is a valid checkout

### 7b — System prompt education

- [x] Update the workspace block in `before_agent_start` handler to explain:
  - This is a clean checkout — gitignored files (node_modules, etc.) are absent
  - This is normal
  - Install dependencies using whatever method the repo recommends
  - Use relative paths; absolute paths pointing at the original repo will be blocked
- [x] Integration test: system prompt contains the explanatory text about missing deps

### 7c — `user_bash` interception

- [x] Import `createLocalBashOperations` from `@earendil-works/pi-coding-agent`
- [x] Register `pi.on("user_bash", ...)` handler in `index.ts`
- [x] When active: wrap `createLocalBashOperations()` and override `cwd` with workspace path
- [x] When inactive: pass through (return `undefined`)
- [x] Integration test: active session returns `{ operations }`, inactive returns undefined
- [x] Integration test: `operations.exec()` ignores passed cwd and runs in workspace path
