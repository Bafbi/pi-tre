# 04: New-session progress from the adapter

**What to build:** `/sillajje:new` shows workspace creation and post-init while it runs. The handler authors the two steps itself, because the workspace boundary has no status sink by design. Progress clears when the new session starts and on failure.

**Blocked by:** 01 — Progress tracer — archive and unarchive

**Status:** done

- [x] The `new` handler renders two adapter-authored Progress steps: creating the workspace and running post-init.
- [x] No Status event is introduced for `new`, and the workspace boundary gains no status sink.
- [x] Progress clears when the session starts and when the command fails.
- [x] The existing per-command post-init notifications and the final Outcome notification are unchanged.

## Notes

- Deviation: the two steps are drawn up front (the handler cannot observe the replacement's workspace creation), and the clear happens in the replacement's `session_start`, which now drops the `sillajje-action` widget. The ticket said "when the session starts", so this is the natural home; the handler only clears on cancel because the captured context is invalid after replacement.
