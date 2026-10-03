# 04: New-session progress from the adapter

**What to build:** `/sillajje:new` shows workspace creation and post-init while it runs. The replacement session's `session_start` authors the two steps itself, because the workspace boundary has no status sink by design. Progress clears in `finally` after setup and freezes on failure.

**Blocked by:** 01 — Progress tracer — archive and unarchive

**Status:** done

- [x] The replacement `session_start` renders two adapter-authored Progress steps: creating the workspace around `workspaces.ensure` and running post-init around `runPostInit`.
- [x] No Status event is introduced for `new`, and the workspace boundary gains no status sink.
- [x] Progress clears in `finally` after setup and freezes on failure.
- [x] The existing per-command post-init notifications and the final Outcome notification are unchanged.

## Notes

- The steps live in the session that does the work, so they are real rather than prefilled and they survive the session replacement. Only a session with a Base marker (a `/sillajje:new`) draws them; a normal startup does not.
- The `startNewSession` handler draws nothing and needs no clear-on-throw; the replacement owns the lifecycle.
