# 03: Stamp progress, including auto-stamp

**What to build:** `/sillajje:stamp` accumulates `collecting-diff`, `generating-header`, and `sealing-change`, where the seal names the session key for a Session stamp and the revision for a Rev stamp. The `agent_settled` auto-stamp shows the same Progress, because it goes through the same shared sink.

**Blocked by:** 01 — Progress tracer — archive and unarchive

**Status:** done

- [x] Core `stamp` emits `sealing-change` with the session key on the Session path and the revision on the Rev path.
- [x] `collecting-diff` and `generating-header` emit no target.
- [x] All stamp entry points that route through the shared sink show Progress: the current-session command, the cross-session command, the Rev command, and the auto-stamp.
- [x] The adapter supplies the phrases for the three stamp codes.
- [x] Integration covers the three-step sequence for a manual stamp.
- [x] Integration covers the same Progress for the auto-stamp after an Interaction settles.

## Notes

- No deviation. The sealing target is the session key on both Session paths (manual and interaction) and the revision on the Rev path.
