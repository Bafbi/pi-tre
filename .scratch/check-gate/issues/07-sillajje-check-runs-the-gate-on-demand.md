# 07: `/sillajje:check` runs the gate on demand

**What to build:** A user can ask for verification without waiting for the agent to stop. The command runs the checks, reports into the transcript, and stops — it never starts a turn on the user's behalf.

**Blocked by:** 01.

**Status:** done

- [x] `/sillajje:check` runs every check the target workspace declares, whatever its Trigger.
- [x] `--trigger settle|publish` narrows the run to one Gate.
- [x] `-s <id>` selects the session target with the existing session-target rules, and `-s @` is the default.
- [x] A target with no live workspace refuses, naming the situation, rather than creating one.
- [x] The report appears in the transcript as a displayed custom message without starting a turn.
- [x] A green run produces an informational outcome naming the checks and their total duration; a red run produces the transcript report plus a warning.
- [x] The run writes a Record with the `manual` invocation trigger and no `Checks:` line, since no stamp happens.
- [x] The retired space form `/sillajje check` is corrected to the colon form instead of reaching the model.
- [x] Tests: the happy path, a narrowing flag, a session without a workspace, and the old-form guard, through the integration harness.

**Deviation:** No deviation.
