# Stamp module: one entry point, injected seams, streamed status, value-based results

The stamp flow (Interaction stamp + Diff stamp) moves out of the pi adapter into a self-contained engine module with a single entry point — `stamp(input, deps): Promise<StampResult>`. Statuses stream during execution through an injected `onStatus` sink; expected failures (jj non-zero exits, sub-generator exhaustion) are returned as `ok: false` values, never thrown. This makes the whole pipeline unit-testable across the same seams the pi adapter crosses — the interface is the test surface.

## Considered Options

**Shape**: one async call + callback sink (chosen) vs async-generator event stream vs class with emitter. The adapter is the only consumer of statuses today, and the push sink is the smallest interface — it matches VS Code's `Progress.report` and listr2's typed event push.

**Source axis**: `interaction: Interaction | null` (chosen) vs a discriminated `{mode: "interaction"|"manual"}` input. The axis is whether the stamp is derived from an Interaction or not — not manual vs auto; the fold flow is a future consumer of the null path.

**Rev targeting**: `rev?: string` default `@` (chosen) — `@` gets the full seal (`update-stale` → `describe` → bookmark → `jj new`), any other rev is describe-only, so fold's stamp step (`diff -r foldId` → header → `describe foldId`) drops in later without an interface change.

**Error policy**: value-based results (chosen) vs exceptions. Expected failures are values — the Rust `Result` default, execa's `failed` flag, neverthrow/fp-ts/Effect all agree; only defects (bugs) throw. `no-changes` (diff-path empty diff) is a distinct normal outcome, not an error — the equivalent of listr2's `SKIPPED` state.

**Config**: the module extracts its stamp options from `SillajjeConfig` internally (chosen) vs the adapter pre-extracting. The sync-drift between schema defaults and extraction is pinned by a unit test instead of a "keep in sync" comment.

## Consequences

- `extractAssistantText`, the thinking-count loop, and `getStampConfig` move from the adapter into the module.
- `setSessionBookmark` is exported from the module so `before_agent_start` reuses it.
- The pi adapter shrinks to: observe events into an Interaction, decide when to stamp, map statuses/results to notifications, reset state.
- The `onStatus` sink is treated as infallible — a throwing sink is caught, never corrupts the stamp.
