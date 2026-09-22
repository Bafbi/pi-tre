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
  - `mise run check` auto-formats the tree first.
  - `mise run ci` verifies formatting without writing and fails on unformatted code.
  - Run formatting on its own with `mise run format`.
- **Vitest** is the testing framework.

## Extension config

An extension that reads configuration uses the shared `@pi-tre/pi-config` loader. Do not hand-roll `readFileSync` and path joining.

- Project config: `<repo-root>/.pi/configs/<extension>.json`
- Global config: `~/.pi/agent/configs/<extension>.json`

The loader resolves both paths with `CONFIG_DIR_NAME` and `getAgentDir()`, deep-merges global then project (project wins per leaf, arrays replaced), strips unknown keys with a warning, and returns a fully-populated object. Pass a TypeBox schema.

The loader ignores the project layer unless the caller passes `trusted: ctx.isProjectTrusted()`. Project config can carry shell commands, so never read it from an untrusted project.

See `docs/adr/0002-extension-config-layout.md`.


## Repo workflow

Every extension exposes these tasks via mise task templates:

- `lint` (Biome, includes the format check)
- `typecheck` (tsc)
- `typecheck-strict` (tsc with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`)
- `test` (hermetic tests)
- `type-aware` (Biome type-aware scan, slow)
- `test-external` (LLM and external-service tests)
- `check` (`lint` + `typecheck` + `test`)
- `ci` (`check` + `type-aware` + `test-external`)

`check` is the fast, hermetic gate. It formats the tree first, then runs the
per-module checks and the root-only checks. A module that did not change skips.
`ci` verifies formatting instead of writing, then adds the slow and non-hermetic
parts.

### Global (full repo)
1. `mise run check` — per-module lint + typecheck + hermetic tests, plus the
   root-only checks. Unchanged modules skip, so a warm run is a few seconds.
2. `mise run ci` — check + type-aware scan + semgrep + non-hermetic tests
   (pnpm deps are auto-installed by `[deps.pnpm] auto = true`)

### Per-extension (single module)
1. `mise run //extensions/<name>:check` — lint + typecheck + hermetic tests for one extension
2. `mise run //extensions/<name>:ci` — check + type-aware + non-hermetic tests
3. Or individual steps: `mise //extensions/<name>:lint`, `:typecheck`, `:test`

Per-module tasks track their `sources` and skip when nothing changed. A change
to a workspace dependency invalidates the consumers that list it. The
`@pi-tre/pi-subagent` and `@pi-tre/pi-config` edges live in
`extensions/repo-query/mise.toml` and `extensions/sillajje/mise.toml`; a new
consumer must add them. Use `mise run --force <task>` to bypass the skip. `ci`
adds the slow scans.


## LLM-backed and service tests

Some tests are not hermetic. The filename marks the category:

- `*.service.test.ts` calls a real external service.
- `*.llm.test.ts` calls a real LLM.

The default test run is hermetic. `scripts/run-vitest.sh` excludes both
categories unless asked:

- `mise run //:test` and `mise run //extensions/<name>:test` run hermetic tests.
- `mise run //:test-external` runs only the non-hermetic tests.
- `mise run //:test-all` runs everything.
- `--all` and `--external` are the underlying script flags.

`mise run check` and per-extension `check` are hermetic. `mise run ci` adds
`//:test-external`, so CI runs everything.

A non-hermetic test must skip, not fail, when its dependency is unavailable. An
LLM test skips with the provider's message when the call fails. A service test
retries once, then skips with a visible reason. `PI_TEST_MODEL` selects the LLM.
Override it in `mise.local.toml` (gitignored) or the shell.

Run tests through mise tasks. A direct `pnpm exec vitest run` bypasses the
hermetic default and the mise `[env]` injection.

## Check requirement

**Any modification to an extension must pass its per-extension check after changes.**
- If the change touches a single extension: `mise run //extensions/<name>:check`
- If the change spans multiple extensions or the root: `mise run check`
- Fix any failures after changes. Do not bypass the check.

The gate is temporarily red. `typecheck-tests` (149 errors),
`typecheck-strict` (65 errors), `//:lint`, `//:knip`, `//:ast-grep` (37 missing
extensions in tests and scripts), `pi-subagent:lint`, `sillajje:lint`, and
`leaf-copy:test` fail on findings the refactor owns. Run
`mise run check-baseline` to tell a new regression from this list. Each task
leaves `check` as the refactor clears it.

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
