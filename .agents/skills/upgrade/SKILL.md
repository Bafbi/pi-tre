---
name: upgrade
description: Upgrade the pi agent harness version in this monorepo. Use when the user wants to upgrade pi, update the pi version, bump pi, check for pi updates, migrate to a new pi release, or update pi-coding-agent / pi-ai / pi-agent-core / pi-tui dependencies.
disable-model-invocation: true
---

# Upgrade pi

Upgrade `@earendil-works/pi-coding-agent` and its sibling packages in this monorepo, guided by the upstream changelog.

## Steps

### 1. Check versions

Read the current version from `pnpm-workspace.yaml` under `catalogs.pi-dev` — it pins `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui` to the same semver range.

Run `npm view @earendil-works/pi-coding-agent version` for the latest published version.

- If current ≥ latest: report nothing to do and stop.
- If latest > current: report the version gap and proceed.

**Completion criterion**: the version gap is stated as a single sentence (e.g. "upgrading from ^0.80.10 to 0.81.1").

### 2. Fetch the changelog

Fetch the raw changelog from:
`https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md`

Extract every version entry between the current version (exclusive) and the latest version (inclusive). Collect all **Breaking Changes** sections from those entries into a single migration checklist.

**Completion criterion**: every breaking change between current+1 and latest is listed, with its source version noted.

### 3. Audit extension APIs

Scan every source file under `extensions/*/src/` and `packages/*/src/` for imports from `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-tui`. For each import, check whether the imported symbol is affected by any breaking change from step 2.

Also scan the test trees (`extensions/*/test/`, `packages/*/test/`) and `.pi/extensions/`. Tests construct pi event payloads and call `ExtensionRunner` methods whose signatures change too; a newly **required** event field breaks `tsc` on tests even when `src` is fine. The per-extension `typecheck` covers `src` only, so run the root `typecheck-tests` to surface these.

**Completion criterion**: every import from a pi package and every constructed pi event payload is accounted for against the breaking-change checklist — each one marked either "unaffected" or "needs migration" with a note.

### 4. Plan the migration

Produce a concrete migration plan as a markdown list. Each item names:
- The file to change
- The specific old API and new API
- The breaking-change version that demands it

For version bumps with no breaking changes affecting this repo, the plan is a single item: "Bump catalog versions in `pnpm-workspace.yaml`."

Present the plan to the user for approval before touching any code.

**Completion criterion**: user has approved the migration plan (explicit confirmation).

### 5. Implement

Implement each item in the migration plan, working through the list in order. Use the TDD skill (`/tdd`) for any item that changes extension logic — write a failing test first, then implement the fix, then confirm the test passes.

For the version bump itself, update the semver range in `pnpm-workspace.yaml` under `catalogs.pi-dev` for all four packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`). Then run `mise deps` to update the lockfile.

**Completion criterion**: every item in the migration plan is implemented, tests pass, and `mise deps` succeeds.

### 6. Verify

Run the full check suite:
```bash
mise run check
```

This runs format, lint, typecheck, and tests. Fix any failures.

**Completion criterion**: `mise run check` exits zero. It includes the root `typecheck-tests` and `typecheck-strict` tasks, which type-check the test trees that per-extension checks skip.

## Reference

### Package catalog

All four packages are versioned together under `catalogs.pi-dev` in `pnpm-workspace.yaml`:

| Package | Catalog key |
|---|---|
| `@earendil-works/pi-coding-agent` | `catalog:pi-dev` |
| `@earendil-works/pi-ai` | `catalog:pi-dev` |
| `@earendil-works/pi-agent-core` | `catalog:pi-dev` |
| `@earendil-works/pi-tui` | `catalog:pi-dev` |

Extensions declare these as `peerDependencies` using `"catalog:pi-dev"`.

### Changelog URL

```
https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md
```

The changelog is one file covering `@earendil-works/pi-coding-agent`. Breaking changes to sibling packages (`pi-ai`, `pi-tui`) are also documented there.

### Version bump mechanics

1. Edit the semver range in `pnpm-workspace.yaml` under `catalogs.pi-dev` — change the `^` range for all four packages.
2. Run `mise deps` to update `pnpm-lock.yaml`. There is no `install` task; `mise deps` runs the configured pnpm provider, and `[deps.pnpm] auto = true` also runs it before any `mise run`.
3. Run `mise run check` to verify nothing is broken.

The lockfile update is a single `pnpm install` — no per-package `pnpm update` needed since the catalog drives resolution for all workspace members.
