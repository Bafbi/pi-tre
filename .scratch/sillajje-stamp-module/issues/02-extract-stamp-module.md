---
Type: task
Status: open
---

# Extract the stamp module from the pi adapter

## Question

Carve the stamp flow out of `extensions/sillajje/src/index.ts` (`stampChange`, `stampManual`, `getStampConfig`, and `setSessionBookmark` as ticket 01 decides) into a self-contained engine module behind ticket 01's decided interface.

- Unit tests cross the mocked seams (ExecFn, SpawnFn) — "the interface is the test surface".
- The pi adapter binds the real seams and maps results + status to notifications.
- `mise //extensions/sillajje:check` passes (lint + typecheck + test).

## Blocked by

- Issue 01 (design the stamp module interface)
