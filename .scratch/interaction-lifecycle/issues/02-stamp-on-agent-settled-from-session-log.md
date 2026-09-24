# 02: Stamp on `agent_settled` from the projected session log

**What to build:** Every Interaction becomes one jj change, derived from the session log and triggered at settle. A pure projection turns the session branch and a cursor into the Interaction's data and entry range. The adapter stamps at `agent_settled`, writes a Stamp marker, and advances the cursor. A steering or follow-up prompt folds into the current Interaction. The defer machinery and the interaction state are deleted.

**Blocked by:** 01 (Prefactor the integration harness to write the session log).

**Status:** done

- [x] `projectInteraction` derives an Interaction from a session branch and a cursor, and returns `undefined` for an incomplete slice.
- [x] Unit tests cover: fresh session with a null cursor; one Interaction; a steering prompt folded in; a follow-up folded in; a retry with a mid-slice error message; a compaction entry inside the slice; a cursor not on the branch; a slice with no assistant message; a slice with no user message.
- [x] A run produces exactly one Session stamp at `agent_settled`.
- [x] A run with a folded follow-up produces one change whose body contains both prompts.
- [x] A Stamp marker with custom type `sillajje/stamp` is written after each Session stamp, and the cursor advances to it.
- [x] The `agent_start` and `agent_end` interaction handlers are deleted; the workspace and jj guards move to the settle handler.
- [x] The `SessionState` interaction fields and their accessors are deleted.
- [x] The synthetic follow-up, steering, and deferral integration tests and the flag-level state tests are deleted or replaced by behaviour-level tests.
- [x] The stale in-code comment claiming `agent_settled` does not reach extension handlers is corrected.
- [x] The extension check passes.

**Deviations:** (1) `deriveInteractionData` now joins every user message into `prompt`, so a folded steering or follow-up prompt reaches the change body. (2) The harness binds `loaded.runtime.appendEntry` directly, because it never calls `runner.bindCore`. (3) The `session_shutdown` flush and the manual-stamp Stamp marker landed here rather than in 03, because removing `clearPendingFinalize`/`resetInteraction` required replacing their call sites.
