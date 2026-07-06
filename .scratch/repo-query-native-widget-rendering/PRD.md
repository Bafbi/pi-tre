---
Status: ready-for-agent
---

# PRD: Native Widget Rendering for repo-query

## Problem Statement

The `repo_query` tool's renderers (`renderCall` and `renderResult`) do not follow the standard widget rendering pattern used by pi's built-in tools (notably `bash`). Instead of reusing component instances across renders, storing state in the render context, and leveraging internal render caches, the code always returns fresh `new Text(...)` or `new Container(...)` objects and ignores the `context` parameter entirely.

This causes:

- **No component reuse**: Every state change (partial update, expand/collapse, theme change) creates entirely new component instances, discarding any render caching the framework's built-in components (`Text`, `Container`) could have provided.
- **No render state tracking**: Timing information (`startedAt`, `endedAt`) and live-update machinery (`setInterval`, `context.invalidate()`) that the bash tool uses cannot be added without rewriting the renderers.
- **No caching cohesion**: The expanded view builds a fresh `Container` with fresh children every render, losing the per-component render caches that `Text`, `Markdown`, and `Container` maintain internally.
- **Pattern divergence**: The code cannot benefit from framework improvements that rely on the standard component-reuse contract. Other extensions cannot look to repo-query as a reference for correct widget rendering.

## Solution

Refactor the `renderCall` and `renderResult` methods of the `repo_query` tool to follow the same pattern used by the built-in `bash` tool:

1. **Reuse components via `context.lastComponent`**: Return the same component instance across successive calls, using the rebuild pattern (clear children, re-add for current state) rather than allocating fresh instances.
2. **Track state in `context.state`**: Store timing (`startedAt`, `endedAt`) and live-update machinery (`interval`) in the render context's shared state object.
3. **Return a consistent component type**: Always return the same `Container` subclass rather than switching between `Text` and `Container` depending on collapsed/expanded state.
4. **Use `context.invalidate()` for live updates**: Drive an elapsed-time counter during exploration (like bash shows "Elapsed: Xs").
5. **Cache rendered output internally**: The custom component caches its rendered lines by width so re-renders at the same width skip recomputation.

The visual output remains identical — same icons, same colors, same layout, same text content. Only the implementation pattern changes.

## User Stories

1. As a **pi user running repo_query**, I want the widget to render without flicker during phase transitions, so that the UI feels responsive and consistent.
2. As a **pi user expanding/collapsing the repo_query result**, I want the transition to be instant, so that I can quickly inspect details without waiting for re-renders.
3. As a **pi user watching repo_query progress**, I want to see an elapsed-time counter during exploration, so that I know how long the search has been running.
4. As a **pi user changing themes**, I want the repo_query widget to pick up the new theme immediately, so that the UI stays visually coherent.
5. As an **extension developer inspecting repo-query's code**, I want the renderers to follow the same pattern as the built-in bash tool, so that I can use the code as a reference for my own extensions.
6. As a **pi maintainer improving the TUI rendering pipeline**, I want all custom tools to reuse component instances properly, so that new framework features (like differential rendering or component recycling) work correctly without special cases.
7. As a **repo-query contributor**, I want the rendering code to be clearly separated into a rebuild function, so that adding new visual states (like a loading spinner or progress bar) is straightforward.
8. As a **test author**, I want to test the renderer by calling `renderResult` with a mock context and asserting on the output text, so that tests are fast, isolated, and don't require the full TUI environment.

## Implementation Decisions

### Module structure

The rendering logic lives in `extensions/repo-query/src/index.ts` (the existing file). No new files are created. The refactoring introduces:

- A **`RepoQueryResultComponent`** class (Container subclass) with internal render-caching state (`cachedWidth`, `cachedLines`). This is analogous to `BashResultRenderComponent` in the bash tool.
- A **`rebuildRepoQueryResultComponent()`** function that clears the component's children and repopulates them based on the current result state (`isPartial`, `expanded`, results, answer, thought, etc.). This is analogous to `rebuildBashResultRenderComponent()`.
- Updated `renderCall` that reuses `context.lastComponent` as a `Text` and calls `.setText()` to update its content, storing `startedAt` in `context.state` when execution begins.
- Updated `renderResult` that reuses `context.lastComponent`, tracks timing in `context.state`, starts/stops a 1-second `setInterval` timer for live elapsed-time updates, and calls `component.invalidate()` after rebuilding.

### State shape in `context.state`

```typescript
// Prototype — from the bash tool's pattern
interface RepoQueryRenderState {
  startedAt?: number;      // Set when executionStarted first fires
  endedAt?: number;        // Set when result is no longer partial
  interval?: ReturnType<typeof setInterval>;  // Timer handle for live updates
}
```

### Component type

`RepoQueryResultComponent` extends `Container`. It adds a `state` property for render caching:

```typescript
class RepoQueryResultComponent extends Container {
  state: {
    cachedWidth?: number;
    cachedLines?: string[];
  } = {};
}
```

The `render()` method is inherited from `Container`. The caching is handled at the rebuild level — when the same component is rebuilt with the same data, the rebuild function reuses `Text` and `Markdown` children that maintain their own internal render caches.

### renderCall pattern

```typescript
renderCall(args, theme, context) {
  const state = context.state;
  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }
  const text = context.lastComponent ?? new Text("", 0, 0);
  text.setText(formatRepoQueryCall(args, theme));
  return text;
}
```

### renderResult pattern

```typescript
renderResult(result, options, theme, context) {
  const state = context.state;

  // Live elapsed-time counter
  if (state.startedAt !== undefined && options.isPartial && !state.interval) {
    state.interval = setInterval(() => context.invalidate(), 1000);
  }
  if (!options.isPartial || context.isError) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }

  // Reuse or create the component
  const component = context.lastComponent ?? new RepoQueryResultComponent();
  rebuildRepoQueryResultComponent(component, result, options, theme, state.startedAt, state.endedAt);
  component.invalidate();
  return component;
}
```

### Rebuild function signature

```typescript
function rebuildRepoQueryResultComponent(
  component: RepoQueryResultComponent,
  result: AgentToolResult<RepoQueryDetails>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  startedAt?: number,
  endedAt?: number,
): void
```

The rebuild function:
1. Calls `component.clear()` to remove all children
2. Checks `result.details` — if absent/empty results, adds a simple `Text`
3. For partial state: adds per-repo status lines (✓/✗/⏳ icons) + last 5 thought lines
4. For complete + collapsed: adds a summary line with icons, truncating errors/warnings
5. For complete + expanded: builds the rich layout with header, query, model, workspace, repos, and markdown answer
6. For all states with timing info: adds an elapsed/took line at the bottom

### Backward compatibility

`renderResult` guards all `context.*` access with optional chaining. If called with `undefined` context (as existing tests do), the code falls back to the current behavior — no state tracking, no component reuse. This ensures existing tests pass without modification.

### Existing tests keep passing

The current four tests in `render.test.ts` pass `undefined` for the render context. The refactored code handles this by:
- Checking `context?.state` before accessing it
- Using `context?.lastComponent ?? undefined` 
- Guarding `context?.invalidate` before calling

### Minimal mock context for new tests

New tests provide a minimal mock context object:

```typescript
function mockRenderContext(overrides?: Partial<...>): ToolRenderContext {
  return {
    state: {},
    lastComponent: undefined,
    invalidate: () => {},
    args: { query: "", repos: [] },
    toolCallId: "test",
    cwd: "/tmp",
    executionStarted: false,
    argsComplete: false,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  };
}
```

## Testing Decisions

### What makes a good test

Tests verify **observable output text** through the public `renderResult` and `renderCall` interfaces. They do not inspect internal state, mock internal functions, or assert on call counts. A test passes when the rendered text contains/does-not-contain expected content. This matches the existing test style.

### Seam

The **single seam** is the `ToolDefinition` interface — specifically `renderCall(args, theme, context) → Component` and `renderResult(result, options, theme, context) → Component`. All tests cross this seam.

### Modules tested

- `extensions/repo-query/src/index.ts` — via the `renderCall` and `renderResult` methods on the registered tool definition.

### Prior art

- The existing `render.test.ts` file tests through this same seam, uses the same `createRunner` test fixture, and asserts on `widget.text`.
- The bash tool's rendering is not tested in the repo-query extension; the pattern is verified implicitly by the framework's own tests.

### New test cases

1. **renderResult with mock context returns expected output** — provides a full `ToolRenderContext`, calls `renderResult`, asserts output text matches expected patterns (same assertions as existing tests, but with real context).
2. **renderResult reuses lastComponent** — calls `renderResult` twice with the same context, verifies the second return value `===` the first.
3. **renderResult tracks startedAt in state** — calls with `executionStarted: true`, verifies `context.state.startedAt` is set.
4. **renderResult sets endedAt when complete** — calls with `isPartial: false`, verifies `context.state.endedAt` is set.
5. **renderResult calls invalidate on component** — after rebuild, component.invalidate() is called (verify by asserting component.state.cachedWidth is undefined).

## Out of Scope

- **Changing the execute logic**: No changes to how repos are cloned, validated, or explored. The subagent spawning in `explorer.ts` is untouched.
- **Changing the debug widget**: The debug panel (`/repo-query-debug`, `ctx.ui.setWidget`) is out of scope.
- **Adding new visual features**: No new UI elements beyond the elapsed-time counter. The visual output stays identical.
- **Changing the output text format**: The text returned by `renderResult` that the LLM sees (via `formatOutput()`) is untouched.
- **Changing the ToolDefinition schema**: No changes to `parameters`, `execute`, `name`, `label`, or `description`.

## Further Notes

- The elapsed-time counter during exploration follows the exact same pattern as bash: a 1-second `setInterval` that calls `context.invalidate()`, driving a re-render without data changes.
- The elapsed counter shows during partial exploration (`isPartial: true`) and is replaced by a "Took Xs" label in the final render.
- The bash tool's `BashResultRenderComponent` stores render cache in a `state` field on the component class itself. `RepoQueryResultComponent` does the same, rather than storing cache in `context.state` (which is shared across call/result renders).
- This refactoring makes the repo-query extension a better reference implementation for other extension authors who want to build custom tools with proper widget rendering.
