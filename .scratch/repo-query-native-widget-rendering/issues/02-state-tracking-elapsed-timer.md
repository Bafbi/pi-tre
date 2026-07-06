---
Type: task
Status: ready-for-agent
---

# State tracking + live elapsed timer

## Parent

PRD: `.scratch/repo-query-native-widget-rendering/PRD.md`

## What to build

Add render-state tracking and a live elapsed-time counter to the `repo_query` widget, following the bash tool's pattern.

**`context.state` shape:**

```
startedAt?: number       — set when executionStarted first fires
endedAt?: number         — set when result is no longer partial
interval?: number        — setInterval handle for live timer
```

**`renderCall`:**
- When `context.executionStarted` is true and `state.startedAt` is undefined, store `Date.now()` in `state.startedAt` and clear `state.endedAt`
- (Component reuse was wired up in slice 1 — this slice only adds timing)

**`renderResult`:**
- When `state.startedAt` is defined and the result is partial and no interval is running, start a 1-second `setInterval` that calls `context.invalidate()`
- When the result is no longer partial (or an error), store `Date.now()` in `state.endedAt`, clear the interval if running
- Append a duration line to the rendered output:
  - During partial: `"Elapsed: X.Xs"`
  - On final: `"Took: X.Xs"`
- Rebuild function receives `startedAt` and `endedAt` parameters

**Tests:**
- Call `renderResult` with `executionStarted: true`, verify `context.state.startedAt` is a number
- Call `renderResult` with `isPartial: false`, verify `context.state.endedAt` is a number
- Call `renderResult` with partial state, verify output contains "Elapsed"
- Call `renderResult` with final state, verify output contains "Took"

## Acceptance criteria

- [x] `context.state.startedAt` is set when `executionStarted` is true
- [x] `context.state.endedAt` is set when result is no longer partial
- [x] 1-second `setInterval` drives `context.invalidate()` during partial exploration
- [x] Interval is cleared when result completes or errors
- [x] Partial render output includes `"Elapsed: X.Xs"` line
- [x] Final render output includes `"Took: X.Xs"` line
- [x] All tests pass

## Blocked by

- Issue 01 (extract rebuild infrastructure + component reuse)
