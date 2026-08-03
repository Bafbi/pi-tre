---
Type: task
Status: claimed
---

# Extract the stamp module from the pi adapter

## Question

Carve the stamp flow out of `extensions/sillajje/src/index.ts` into a self-contained engine module behind the interface decided in ticket 01 (see its `## Answer`): `stamp(input, deps): Promise<StampResult>` with the `Interaction` / `StampInput` / `StampDeps` / `StampStatus` / `StampResult` types, the interaction|diff axis, and rev-targeting (`@` → full seal; other rev → describe-only).

- `extractAssistantText`, the thinking-count loop, and `getStampConfig` move from the adapter into the module.
- `setSessionBookmark` lives in the module and is exported; `before_agent_start` reuses it.
- Unit tests cross the mocked seams (ExecFn, SpawnFn) — "the interface is the test surface"; a config-extraction test pins the defaults against `Default(SillajjeConfigSchema, {})`.
- The pi adapter binds the real seams and maps statuses + results to notifications. The mapping policy: phases are debug-only, warnings/errors notify.
- `mise //extensions/sillajje:check` passes (lint + typecheck + test).

## Blocked by

- Issue 01 (design the stamp module interface)
