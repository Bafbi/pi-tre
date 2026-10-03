# 01: Progress tracer — archive and unarchive

**What to build:** Running `/sillajje:archive` or `/sillajje:unarchive` shows a Progress widget above the editor naming the step and the session key, marks the step done, and clears when the command returns. This ticket introduces the whole path: the `target` field on a Status event's phase, the adapter renderer and its unit seam, the sink wiring, the clear-in-`finally` lifecycle, and the harness widget capture. A thrown action error strands no widget. An error status freezes the step with a cross until the next command. With no UI, Progress is a no-op.

**Contract shape** (from the spec): the phase variant of a Status event becomes `{ kind: "phase"; code: string; target?: string }`. `code` stays the stable key; the adapter owns the wording.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] A Status event's `phase` variant carries an optional `target`; `archive` and `unarchive` emit the session key.
- [x] The adapter renders Progress in a widget above the editor under its own key, distinct from the session pill and the serve indicator.
- [x] The renderer maps a Status event to widget lines: a finished step shows a check, the current step shows a dot and its target.
- [x] The widget clears when the command returns (in `finally`), so a throw strands no widget.
- [x] An error status freezes the failed step with a cross and keeps the widget until the next command starts.
- [x] A command whose action throws leaves no widget behind.
- [x] Mid-run warnings leave the current step visible.
- [x] Progress is a no-op when the host has no UI, and nothing throws.
- [x] Unit tests drive the renderer with a fake widget sink and cover accumulation, markers, freeze, and clear.
- [x] Core tests assert the `target` on the archive and unarchive phases.
- [x] The integration harness captures widget calls and asserts the widget appears during the command and clears on success.

## Notes

- Deviation: the adapter guards the widget call (`progressWidget` returns undefined when the host has no UI or no `setWidget`), so the older UI mocks that predate the widget keep working instead of throwing. Not requested by the ticket.
- The target is the unqualified session id (`s1`), which is what the Outcome notification already prints.
