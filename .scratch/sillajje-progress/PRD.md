# Sillajje Progress — PRD

Status: ready-for-agent

A running sillajje Action explains itself: a live widget shows each step and
its target, marks finished steps, and freezes on the step that failed.

## Problem Statement

A sillajje command is opaque while it runs. A `fold` replays commits and
pushes to remotes; a `stamp` waits on two sub-generators; `archive` and
`unarchive` move a workspace. All of them can take seconds. The TUI shows
nothing until the command returns.

The core already streams a **Status event** for each step it takes — `folding`,
`pushing`, `collecting-diff`, `generating-header`, `sealing-change`,
`rebasing`, `archiving`, `unarchiving` — but the adapter logs every phase to
the debug log and renders none of it. A user cannot tell a slow push from a
hang. When a `fold` fails, the failure notification says a conflict happened
but not which step produced it.

## Solution

The adapter renders the Status events it already receives. A widget above the
editor accumulates the run's phases: a finished phase shows a check, the
current phase shows a dot and names its target (`folding onto trunk`,
`pushing review-branch`, `sealing sillajje/abc123`), and the failed step shows
a cross and stays visible until the next command. The widget clears when the
Action returns. The Outcome notification is unchanged and still carries the
result.

Each Action also names its target on the phase it emits, so the line says what
the step touches, not only that it ran.

## User Stories

1. As a pi user running a slow command, I want to see which step is running,
   so that I know the command has not hung.
2. As a pi user, I want each step to name its target, so that I know what the
   step touches.
3. As a pi user, I want finished steps to stay visible with a check, so that I
   can see the shape of the run.
4. As a pi user, I want the failed step marked with a cross and kept, so that
   I can see where the command broke.
5. As a pi user, I want progress in a widget above the editor rather than the
   footer, so that my footer stays uncluttered.
6. As a pi user, I want the widget cleared when the command finishes, so that
   no stale progress lingers.
7. As a pi user, I want the Outcome notification to survive the cleared
   widget, so that I still have the result.
8. As a pi user running `fold`, I want to see the replay step, so that a slow
   replay is explained.
9. As a pi user running `fold --push`, I want to see the push step and its
   bookmark, so that a slow network push is explained.
10. As a pi user running `sync`, I want to see the rebase step and its target
    revision, so that the operation is legible.
11. As a pi user running `stamp`, I want to see diff collection, header
    generation, and sealing, so that the sub-generator wait is explained.
12. As a pi user running `archive`, I want one short step, so that a fast
    command does not flash a long list.
13. As a pi user running `unarchive`, I want to see the restore step and the
    session key, so that I can confirm the target.
14. As a pi user letting the auto-stamp fire after an interaction, I want the
    same progress, so that the pause after the agent settles is explained.
15. As a pi user running `new`, I want to see workspace creation and the
    post-init commands, so that the slowest command is no longer opaque.
16. As a pi user running a command in print or JSON mode, I want nothing to
    break, so that automation is unaffected.
17. As a pi user, I want the session pill in the footer to keep reporting
    session state, so that I do not lose the workspace path.
18. As a pi user running a second command after a failure, I want the frozen
    widget replaced, so that I never read stale progress.
19. As a pi user, I want a command that throws unexpectedly to leave no stuck
    widget, so that the TUI stays clean.
20. As a pi user, I want mid-run warnings to leave the current step visible,
    so that a degraded run is still explained.
21. As an RPC client, I want the progress events emitted, so that a client can
    render them without a TUI.
22. As a maintainer, I want the core to stay free of pi, so that a future
    adapter reuses the same events.
23. As a maintainer, I want the phase code to stay the stable contract key, so
    that tests assert codes and targets, not UI copy.
24. As a maintainer, I want the target field optional, so that a phase with no
    natural target stays valid.
25. As a maintainer, I want the renderer unit-tested against a fake widget
    sink, so that the wording and the accumulation are covered without a
    terminal.
26. As a maintainer, I want integration coverage that the widget clears on
    success and freezes on failure, so that the lifecycle cannot regress.

## Implementation Decisions

**The core contract gains one optional field.** The phase variant of a Status
event carries its target:

```ts
| { kind: "phase"; code: string; target?: string }
```

`code` stays the stable key and the core owns the codes. `target` is a value
the core already holds at the emit site, not UI copy.

**The adapter owns the wording.** A code-to-phrase map lives in the adapter,
so changing `folding` to "replaying" never touches core tests. A phase with no
target renders as the step alone.

**Targets per Action:**

- `fold` `folding` → the target revision (`--onto`) or the review bookmark
  (`--update`); `pushing` → the advanced bookmark.
- `sync` `rebasing` → the target revision.
- `archive` `archiving`, `unarchive` `unarchiving` → the session key.
- `stamp` `collecting-diff` and `generating-header` → no target;
  `sealing-change` → the session key for a Session stamp, the revision for a
  Rev stamp.
- `serve` and `status` emit no phases and get no progress. This is deliberate
  and matches the scope rule.

**One new adapter module renders Progress.** A factory takes the UI context
and returns `{ onStatus, step, fail, end }`. It maps a Status event to a list
of widget lines and calls the widget API. It owns its own widget key, so it
never fights the session pill (`sillajje`) or the serve indicator
(`sillajje-serve`). The widget sits above the editor. It clears any stale
widget at once, then waits a short delay before drawing the first running
step, so an instant command never draws; a failure draws at once.

**The shared status sink calls the renderer.** The existing sink that maps
Status events to debug logs and notifications gains the render branch. Every
command that builds ports through it gets Progress for free, and the core
needs no change beyond `target`.

**The lifecycle clears in `finally`.** The command handlers wrap the Action
call so that a thrown error cannot strand the widget. On an error Status event
the renderer marks the current step with a cross and leaves the widget; the
next command clears it at the start.

**Auto-stamp reuses the sink.** The `agent_settled` Session stamp goes through
the same ports, so it shows the same Progress.

**`new` gets adapter-authored Progress.** The workspace boundary has no status
sink by design, so `new` does not go through the renderer's event stream. The
replacement session's `session_start` drives two adapter-authored steps —
creating the workspace around `workspaces.ensure`, running post-init around
`runPostInit` — so the steps are real and outlive the session replacement.
Giving the workspace boundary a status sink is a separate decision and is not
taken here.

**The debug log keeps its records.** Each phase still writes
`action_phase_<code>`, now with the target. The debug log is a separate sink
from Progress.

## Testing Decisions

A good test drives a module with inputs and asserts externally visible
outputs — the widget lines, the notifications, the emitted events — never an
internal call. Wording and accumulation are behavior; a private helper is not.

**Core (existing seam).** The Action factories take an `onStatus` port, and
the test suites already capture a `statuses` array and assert phase codes. Add
assertions that `target` is filled at the emit sites above. Prior art:
`fold`, `sync`, `archive`, and `stamp` test files.

**Adapter renderer (one new seam).** Unit-test the renderer with a fake
widget sink that records every call. Cover: a sequence of phases accumulates
in order; the current step carries the running marker; a completed step
carries the done marker; an error event freezes the failed step; `clear`
empties the widget without clearing the notification. Prior art:
`status-pill` for the pure-formatting style and `serve` for the
injected-dependency style.

**Adapter integration (existing seam).** The runner harness's UI mock gains a
widget capture, next to the existing notification capture. Assert that a
`fold` command shows the widget during the run and clears it on success, and
that a failing `fold` leaves the failed step visible. Prior art: the
`onNotify` capture in the harness and the stamping integration tests.

## Out of Scope

- Writing sillajje's actions into the session file, so a later agent can
  review how sillajje was used.
- A per-commit fold counter. The jj facade replays a range in one call, so a
  counter needs a new facade surface for a cosmetic gain.
- Any change to the footer. The pill and the serve indicator keep their keys.
- Progress for `serve` and `status`.
- Rewording the Outcome notifications.
- A status sink on the workspace boundary.
- Animations, spinners, and elapsed-time display.

## Further Notes

The core's `StatusEvent` comment already claims that "the adapter renders
`phase` as progress". That comment becomes true; it stops being aspirational.

The choice to put Progress in a widget, and to freeze on the failed step, is
reversible and not surprising, so it does not warrant an ADR.

Glossary entries are written: **Status event** in `sillajje-core`, and
**Progress** and **Outcome** in the sillajje extension. The word "feedback"
names the capability in this document and stays out of the glossary.
