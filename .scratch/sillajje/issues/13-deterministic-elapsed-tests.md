# 13 — Make elapsed-time tests deterministic

**What to build:** `state.test.ts` elapsed-time tests use `setTimeout(10)` and `Date.now()` comparisons with tolerance ranges — they can flake on slow or overloaded CI machines. Replace with `vi.useFakeTimers()` so time advances deterministically. No API change to `SessionState` needed since it uses `Date.now()` internally, which fake timers intercept.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Wrap elapsed-time test cases in `vi.useFakeTimers()` / `vi.useRealTimers()` blocks
- [ ] Replace `await new Promise(r => setTimeout(r, 10))` with `vi.advanceTimersByTime(10)` — no real waiting
- [ ] Assert exact elapsed values rather than tolerance ranges: `expect(elapsed).toBe(10)` instead of `expect(elapsed).toBeGreaterThanOrEqual(5)`
- [ ] `getInteractionElapsedMs returns cumulative when no running segment`: advance time, call `markAgentEnd`, advance more time, assert value is frozen at end time — deterministic
- [ ] `markAgentEnd accumulates multiple segments`: advance by fixed amounts per segment, assert cumulative total is sum
- [ ] `getInteractionElapsedMs returns cumulative when no running segment`: advance time, call markAgentEnd, advance more time, assert value is frozen — deterministic
- [ ] All 32 state tests still pass
- [ ] Tests run in under 100ms total (currently ~50ms with real timers, should be faster)

