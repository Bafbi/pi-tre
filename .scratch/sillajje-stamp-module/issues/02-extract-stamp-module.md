---
Type: task
Status: claimed
---

# Extract the stamp module from the pi adapter

## Question

Carve the stamp flow out of `extensions/sillajje/src/index.ts` into a self-contained engine module behind the interface decided in ticket 01 (see its `## Answer`): `stamp(input, deps): Promise<StampResult>` with the `StampInput` / `StampDeps` / `StampStatus` / `StampResult` types (interaction input is pi's own `Message[]` transcript, or `null` for the diff path — no custom interaction type), the interaction|diff axis, and rev-targeting (`@` → full seal; other rev → describe-only).

- `extractAssistantText`, the thinking-count loop, and `getStampConfig` move from the adapter into the module.
- `setSessionBookmark` lives in the module and is exported; `before_agent_start` reuses it.
- Unit tests cross the mocked seams (ExecFn, SpawnFn) — "the interface is the test surface"; a config-extraction test pins the defaults against `Default(SillajjeConfigSchema, {})`.
- The pi adapter binds the real seams and maps statuses + results to notifications. The mapping policy: phases are debug-only, warnings/errors notify.
- `mise //extensions/sillajje:check` passes (lint + typecheck + test).

## Blocked by

- Issue 01 (design the stamp module interface)

## Comments

### 2026-08-04 — CodeRabbit review response (PR #7)

Addressed the review's still-valid findings; several were already fixed by
prior commits (`cc1d625`, `8b9b78c`, `c2b5236`, `a8dc66d`, `69c41b5`):

- Interaction early `failed` returns now emit distinct error statuses
  (`missing_interaction_input`, `derive_interaction_failed`) before returning.
- Rejected `jj diff` fetches are handled in both paths: interaction path
  degrades to an empty diff (auxiliary context); diff path returns
  `failed` with a `diff_fetch_failed` error status (distinct from no-changes).
- Sub-generators now return an explicit `fellBack` flag (`GeneratedText`),
  replacing text-comparison heuristics in both stamp paths and the fold path.
- Adapter no longer double-notifies: the status sink is the single error
  notification point; `stampManual` now calls `resetInteraction()` after a
  successful seal so stale interaction metadata isn't reused.
- Tests: deep-merged `defaultConfig`; user_prompt skip test now asserts
  behavior; diff-failure test renamed + a rejection test added; reset test
  pins `lastRunEndedInError` clearing; removed the invalid `as const` in the
  integration fixture.

Deliberately skipped: splitting `StampInput` so Interaction stamps cannot
override `rev` — the adapter already pins `rev: "@"`, `stampInteraction`
handles any rev defensively, and rev targeting was verified working as
intended (see commit `dfe361c`). The split would add churn without a
runtime benefit.

Validated: `mise //extensions/sillajje:check` passes (298 tests).
