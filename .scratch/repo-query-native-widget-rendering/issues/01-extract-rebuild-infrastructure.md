---
Type: task
Status: ready-for-agent
---

# Extract rebuild infrastructure + component reuse

## Parent

PRD: `.scratch/repo-query-native-widget-rendering/PRD.md`

## What to build

Refactor the `renderCall` and `renderResult` methods of `repo_query` to follow the bash tool's component-reuse pattern. The visual output stays identical — this is purely an implementation restructuring.

**`renderCall`:**
- Accept a `Text` component via `context.lastComponent` and update it with `.setText()` instead of allocating a new `Text` every call
- Always return the same `Text` instance across successive calls

**`renderResult`:**
- Extract all current rendering logic (partial view, collapsed view, expanded view) into a standalone `rebuildRepoQueryResultComponent()` function that clears a Container and repopulates its children
- Create a `RepoQueryResultComponent` Container subclass with an internal render-cache field
- Accept the component via `context.lastComponent` and reuse it across calls
- Always return a `RepoQueryResultComponent` (same type), never switching between `Text` and `Container`
- Guard all `context.*` access with optional chaining so existing callers that pass `undefined` still work

**Tests:**
- Update existing tests in `render.test.ts` to pass a `mockRenderContext()` instead of `undefined`
- Add new test: calling `renderResult` twice with the same context returns the same component instance (`===`)
- Verify existing output-text assertions still pass unchanged

## Acceptance criteria

- [x] `renderCall` reuses `context.lastComponent` via `.setText()` and returns the same instance on successive calls
- [x] `renderResult` reuses `context.lastComponent` via the rebuild function and returns the same instance on successive calls
- [x] `RepoQueryResultComponent` is a Container subclass with internal render-cache state
- [x] `rebuildRepoQueryResultComponent()` handles all three render paths (partial, collapsed, expanded) with identical visual output
- [x] Existing tests pass with `mockRenderContext()` instead of `undefined`
- [x] New test asserts `===` identity across two `renderResult` calls
- [x] No elapsed-time counter (that is slice 2)

## Blocked by

None — can start immediately
