## Philosophy
- Build small, focused Pi extensions with clear boundaries.
- Optimize for fast local iteration and excellent developer experience (DevX).
- Prefer explicit, readable code and predictable behavior over cleverness.

## Tooling standards
- **Mise is the source of truth** for dev tools and shared tasks.
  - Use `mise run <task>` instead of ad-hoc one-off commands when possible.
  - Use monorepo task syntax for per-extension tasks: `mise //extensions/<name>:<task>`.
- **pnpm** is the only package manager for this monorepo.
  - Use workspaces for shared tooling and extension packages.
- **Biome** handles formatting + linting.
  - Run formatting before committing.
- **Vitest** is the testing framework.

## Extension config

An extension that reads configuration uses the shared `@pi-tre/pi-config` loader. Do not hand-roll `readFileSync` and path joining.

- Project config: `<repo-root>/.pi/configs/<extension>.json`
- Global config: `~/.pi/agent/configs/<extension>.json`

The loader resolves both paths with `CONFIG_DIR_NAME` and `getAgentDir()`, deep-merges global then project (project wins per leaf, arrays replaced), strips unknown keys with a warning, and returns a fully-populated object. Pass a TypeBox schema.

The loader ignores the project layer unless the caller passes `trusted: ctx.isProjectTrusted()`. Project config can carry shell commands, so never read it from an untrusted project.

See `docs/adr/0002-extension-config-layout.md`.


## Repo workflow

Every extension exposes four tasks via mise task templates: `lint`, `typecheck`, `test`, and `check` (which runs all three).

### Global (full repo)
1. `mise run check` — lint + typecheck + test across all extensions
   (pnpm deps are auto-installed by `[deps.pnpm] auto = true`)

### Per-extension (single module)
1. `mise run //extensions/<name>:check` — lint + typecheck + test for one extension
2. Or individual steps: `mise //extensions/<name>:lint`, `:typecheck`, `:test`


## LLM-backed tests

Extensions may ship tests that call a real LLM (for example, repo-query's live
subagent test). Such tests:

- Read `PI_TEST_MODEL` and skip when it is unset.
- Run tests that need a real LLM when `PI_TEST_MODEL` is set.
- Skip with the provider's message when the LLM call fails. A broken provider
  never fails the suite.

The default Mise environment provides a cheap `PI_TEST_MODEL`. Override it in
`mise.local.toml` (gitignored) or in your shell when another provider is needed.
Use `mise run ... --no-llm` to exclude LLM-backed tests and
`mise run ... --no-service` to exclude tests that call real external services.
These flags apply to `test` and `check` tasks.

Run tests through mise tasks (`mise run //extensions/<name>:test`). A direct
`pnpm exec vitest run` does not get mise's `[env]` injection and skips the
LLM-backed tests when `PI_TEST_MODEL` is unavailable.

## Check requirement

**Any modification to an extension must pass its per-extension check before committing.**
- If the change touches a single extension: `mise //extensions/<name>:check`
- If the change spans multiple extensions or the root: `mise check`
- Fix any failures before committing. Do not bypass the check.

## VCS
- You do not care about VCS.

## DevX expectations
- Document intent in code and docs, not just implementation details.
- Keep extension state/behavior debuggable (clear logs, explicit guards, deterministic paths).
- Avoid hidden magic and surprising side effects.
- Prefer safe defaults; require explicit override for risky behavior.

## Agent skills

### Issue tracker

Issues are tracked as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles using default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context monorepo — `CONTEXT-MAP.md` at root maps to per-extension `CONTEXT.md` files under `extensions/<name>/`. See `docs/agents/domain.md`.
