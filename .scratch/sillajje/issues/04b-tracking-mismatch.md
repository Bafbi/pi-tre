# 04b — Fix elapsed time tracking mismatch

**What to build:** The current implementation uses `agent_start` to mark the start of elapsed time and `agent_end` for stamping (because `agent_settled` does not reliably reach extension handlers in this Pi version). However, `agent_end` may fire multiple times per interaction (once per response chunk), while `agent_start` fires only once. This means:

- `agent_start` → first `agent_end`: correct elapsed tracking
- Subsequent `agent_end` firings: the `markAgentStart()` was called long ago, so the elapsed time reflects from the *original* start to the *last* chunk — which actually may be the desired behaviour (total wall-clock time from first agent invocation to last output).

But there's a subtler problem: if `agent_start` fires after the agent's first tool use (in retry/compact scenarios), the timer starts late and undercounts elapsed time. The current `SessionState.markAgentStart()` is called unconditionally in `agent_start`, so the last `agent_start` wins.

**The real issue:** The elapsed time is measured from `agent_start` to `stampChange()` (called inside `agent_end`). But `agent_start` fires at the start of agent execution, and stamping happens in `agent_end` which may fire *after* retries, compactions, or multiple chunks. The elapsed time is therefore the total session time from first agent start to stamp, which is roughly correct — but `agent_start` could fire multiple times (e.g. after steering when a new agent starts), resetting the clock.

**Blocked by:** 04 — Change stamping

**Status:** complete

## Problem scenarios

1. **Multiple `agent_end` firings**: `agent_end` fires for each response chunk. The last chunk's firing triggers `stampChange()`. The elapsed time (`Date.now() - agentStartAt`) is measured from the first `agent_start` — this is acceptable but slightly imprecise if there were long gaps between chunks.

2. **`agent_start` fires again mid-interaction**: If a retry or compaction triggers a new `agent_start`, the timer resets. The elapsed time only captures the last agent run, not the full interaction.

3. **Steering edge case**: User steers → `agent_start` fires again → timer resets. But the change isn't stamped until after the steered response, so the elapsed time only covers the steered segment, not the full interaction including the initial run.

## Proposed fix

The fix options are:

**Option A — Track agent run segments.** Keep a cumulative elapsed counter in `SessionState`. On each `agent_start`, record a segment start. On each `agent_end`, add the segment duration to a cumulative total. Reset on new interaction, not on `agent_start`.

**Option B — Single timer, first `agent_start` only.** Guard `markAgentStart()` so it only sets the timer on the first call after an interaction starts, ignoring subsequent `agent_start` calls. This gives total wall-clock time from initial agent invocation to final stamp.

**Option C — Move timer to `before_agent_start`.** Start the timer when the prompt is captured (in `before_agent_start`) rather than in `agent_start`. This captures the full time including any overhead between prompt delivery and first agent execution.

## Decision

Record a **cumulative elapsed tracker** in `SessionState`:

```typescript
private segmentStartAt = 0;
private cumulativeElapsedMs = 0;

markAgentStart(): void {
  this.segmentStartAt = Date.now();
}

markAgentEnd(): void {
  if (this.segmentStartAt > 0) {
    this.cumulativeElapsedMs += Date.now() - this.segmentStartAt;
    this.segmentStartAt = 0;
  }
}

getInteractionElapsedMs(): number {
  // Add the current running segment if agent is still active
  const running = this.segmentStartAt > 0 
    ? Date.now() - this.segmentStartAt 
    : 0;
  return this.cumulativeElapsedMs + running;
}
```

This handles:
- Multiple `agent_end` chunks → each chunk adds its segment (`agent_start` → `agent_end`), cumulative total grows
- `agent_start` reset → continues from where previous segments left off
- Steering → cumulative continues, not reset
- `stampChange()` reads cumulative total, then `resetInteraction()` clears everything

## Tasks

- [x] Add `segmentStartAt` and `cumulativeElapsedMs` fields to `SessionState`
- [x] Add `markAgentEnd()` method that accumulates elapsed segment time
- [x] Modify `agent_start` handler to call `state.markAgentStart()` (already done — no change needed)
- [x] Add `agent_end` handler call to `state.markAgentEnd()` before extracting the response
- [x] Change `stampChange()` to read cumulative elapsed from `getInteractionElapsedMs()` (already reads snapshot.elapsedMs which calls `getInteractionElapsedMs()`)
- [x] Reset cumulative counters in `resetInteraction()`
- [x] Update unit tests for `SessionState` interaction tracking (segment accumulation, multiple segments, active segment contribution, reset)
- [x] Integration test: `elapsed:` appears in stamped commit body
