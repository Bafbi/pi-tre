# pi-tre

Monorepo for **Pi coding-agent extensions**.

Built for fast local iteration with:
- `mise` (tools + task runner)
- `pnpm` (workspace package manager)
- `biome` (format + lint)
- `vitest` (tests)

## Extensions in this repo

- **stale-write-guard**
  Docs: [`extensions/stale-write-guard/README.md`](./extensions/stale-write-guard/README.md)
- **repo-query**
  Docs: [`extensions/repo-query/README.md`](./extensions/repo-query/README.md)
- **sillajje**: automatic jj change stamping per agent session

## Packages in this repo

- **@pi-tre/pi-subagent**: one `runSubagent` contract for headless pi subagents with a process backend and an in-process backend.
  Docs: [`packages/pi-subagent/README.md`](./packages/pi-subagent/README.md)

## Install from GitHub

This is a pnpm workspace. `repo-query` and `sillajje` depend on the workspace
package `@pi-tre/pi-subagent` through `workspace:*`. The default install runs
`npm install --omit=dev`, which does not link workspace packages, so both
extensions fail to load with `Cannot find module '@pi-tre/pi-subagent'`.

Tell pi to install with pnpm. Add this to `~/.pi/agent/settings.json` (it
applies to every pi install, including the temporary `-e git:...` below):

```json
{
  "npmCommand": ["pnpm"]
}
```

`pnpm` must be on `PATH` (`corepack enable pnpm`, `npm install -g pnpm`, or
this repo's `mise` setup).

Then install with Pi package support:

```bash
# global install
pi install git:github.com/Bafbi/pi-tre

# project-local install (writes to .pi/settings.json)
pi install -l git:github.com/Bafbi/pi-tre
```

This repo exposes extensions through the `pi` manifest in `package.json`.

## Temporary / one-off usage

```bash
# from git (no permanent install)
pi --no-extensions -e git:github.com/Bafbi/pi-tre

# from local checkout
pi --no-extensions -e ./extensions/stale-write-guard/src/index.ts
```

## Local development

```bash
mise deps
mise run check
```

To test the local checkout, start a session with it loaded:

```bash
pi --no-extensions -e .
```

`-e .` reads the `pi` manifest in `package.json` and loads every extension from this checkout. `--no-extensions` keeps the installed package and the auto-discovered `.pi/extensions` out of the session, so the local source is the only copy loaded. Run it from the repo root.

For one extension:

```bash
pi --no-extensions -e ./extensions/repo-query/src/index.ts
```

## Security note

Pi extensions run with your user permissions. Install only from trusted sources.
