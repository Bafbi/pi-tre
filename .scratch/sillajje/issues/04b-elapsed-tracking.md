# 04b — Fix elapsed time tracking mismatch

**What to build:** The current implementation uses `agent_start` to mark elapsed time and `agent_end` for stamping. But `agent_end` may fire multiple times per interaction (once per response chunk), while `agent_start` fires only once. The elapsed time should account for retries, compactions, and multiple chunks accurately by using a cumulative segment tracker.

**Blocked by:** 04 — Change stamping (complete)

**Status:** ready-for-agent

## Problem

- `agent_start` sets a single timestamp. But in retry/compact scenarios, `agent_start` fires again, resetting the timer.
- `agent_end` fires for each chunk; stamping happens on the last one. Elapsed time only covers the final segment, not the full interaction.
- Steering: `agent_start` fires again after the steer, timer resets.

## Solution

Add a **cumulative elapsed tracker** to `SessionState`:

```
agent_start → record segment start
agent_end   → add segment duration to cumulative total
              (agent_start → agent_end wall-clock delta)
getInteractionElapsedMs() → cumulative + current running segment (if agent still active)
resetInteraction() → clear cumulative and segments
```

## Tasks

- [ ] Add `segmentStartAt` and `cumulativeElapsedMs` fields to `SessionState`
- [ ] Add `markAgentEnd()` method that accumulates elapsed segment time
- [ ] Add `enableInteractionIfNotSteering()` guard doesn't reset cumulative
- [ ] Wire `state.markAgentEnd()` in the `agent_end` handler before stamping
- [ ] Change `stampChange()` to read cumulative elapsed from `getInteractionElapsedMs()`
- [ ] Reset cumulative counters in `resetInteraction()`
- [ ] Unit tests: segment accumulation, multiple segments, active segment contribution, reset
- [ ] Integration test: simulate multi-chunk interaction, assert elapsed time in metadata is cumulative
