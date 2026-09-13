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

Install with Pi package support:

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
pi -e git:github.com/Bafbi/pi-tre

# from local checkout
pi -e ./extensions/stale-write-guard/src/index.ts
```

## Local development

```bash
mise deps
mise run check
pi "test the new feature"
```

## Security note

Pi extensions run with your user permissions. Install only from trusted sources.
