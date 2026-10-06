# Persist sillajje Records in the session log

Status: ready-for-agent

## Problem Statement

When a sillajje operation fails or does something surprising, the evidence disappears. A fold squashes with a fallback subject, a session archives itself, an auto-stamp never fires, and all that is left is a notification the user already dismissed and a debug log that is off by default. After the fact, neither the user nor an agent can tell what sillajje did, what it resolved, or why it stopped. Diagnosing a bad run means reverse-engineering jj's operation store and guessing at inputs.

## Solution

Sillajje writes a **Record** to the session log for every operation it drives. A Record is observational — the extension never reads it back — and it sits in the session file beside the transcript, so the user or an agent can open the log and reconstruct the run. Each operation writes a start Record and a terminal Record: done, failed, or noop. Records never enter the model's context, so a verbose log never grows a prompt.

The read surface is the session file itself. No command, no viewer.

## User Stories

1. As a user, I want a Record of a failed fold, so that I can see the resolved base and tip, the input flags, and jj's error without turning on debug logging.
2. As a user, I want the sub-generator fallback flags in a Record, so that a fold that squashed with `chore: agent interaction` tells me the generator was exhausted rather than that the diff was empty.
3. As a user, I want the diff manifest in a Record, so that I can see which files were omitted, how large they were, and why.
4. As a user, I want a start Record written before the jj work begins, so that a process that dies mid-operation still leaves the input behind.
5. As a user, I want a noop outcome recorded, so that I can tell a stamp that found nothing to stamp from a stamp that never ran.
6. As a user, I want a Record when the workspace is created, reused, or fails to build, so that a session that starts from an empty tree or a dead path is explainable.
7. As a user, I want a Record of every Seed copy, push, and pull, so that a seeded file that turned up missing or diverged can be traced.
8. As a user, I want a Record of the Base a `/sillajje:new` resolved, so that a session that branched from the wrong place is explainable after a reload.
9. As a user, I want a Record of every auto-stamp, manual stamp, cross-session stamp, and rev stamp, so that I can see which stamps ran and what they produced.
10. As a user, I want the stamp's Source recorded, so that I can tell an Interaction stamp from a diff-only stamp.
11. As a user, I want a Record of the shutdown flush, so that work stamped only as the process ended is not invisible.
12. As a user, I want a Record of every fold, so that I can see the target, the marker written, the bookmark advanced, and the remotes pushed.
13. As a user, I want a Record of every sync, so that a merge that conflicted or moved the session unexpectedly is explainable.
14. As a user, I want a Record of every archive and unarchive, including the auto-archive at shutdown, so that a session that retired "for no reason" names the trigger.
15. As a user, I want the archive Record to distinguish the `/sillajje:archive` command from the shutdown auto-archive, so that I can tell what asked for it.
16. As a user, I want a Record when a tool call is blocked, so that an agent that was stopped from writing outside the workspace leaves a trace.
17. As a user, I want a Record when the extension corrects an old command form, so that a mistyped command does not silently become a different one.
18. As a user, I want every failure Record to carry the failing status code and jj's message, which names the subcommand and includes the exit code and stderr, so that I can reproduce the command from the Record.
19. As a user, I want each Record to carry the resulting change id when there is one, so that I can join the Record to `jj log` and `jj show`.
20. As a user, I want a Record for an operation that failed before it resolved a target, so that an input error is as visible as a jj error.
21. As a user, I want Records to be versioned, so that an older Record in an older session file is still readable after the schema grows.
22. As a user, I want one Record type with an operation discriminator, so that grepping the session file for one string finds every sillajje record.
23. As an agent, I want to read the session log and find structured Records, so that I can diagnose a prior run without a live process or a debug flag.
24. As an agent, I want the start Record to name the operation and its inputs, so that a run that crashed before completion is still explainable.
25. As a user, I want Records excluded from the model's context, so that a long session does not grow its prompt from its own diagnostics.
26. As a maintainer, I want the behavioral **Markers** (Base, Stamp, Folded source, Seed) to stay separate from Records, so that a change to the diagnostic stream can never move a cursor or a base handoff.
27. As a maintainer, I want no per-jj-command Records, so that a fold's eight jj calls stay in the debug log and out of the session file.
28. As a maintainer, I want the core to return the diagnostics and the adapter to write them, so that the core keeps its no-pi import boundary.
29. As a maintainer, I want the diff collector to return its omitted-file list instead of only rendering it, so that the manifest can be persisted rather than re-derived.
30. As a user, I want a failed Record to be written even when the operation throws rather than returning a failure, so that an unexpected crash is not the one case with no trace.

## Implementation Decisions

**One session-log entry type.** The adapter writes `customType: "sillajje/record"` through `pi.appendEntry`. One type with an operation discriminator, not one per operation. The extension never reads these entries back.

**Two writes per operation.** A `start` Record, then a terminal `done | failed | noop` Record. The start Record carries the input and whatever was resolved before the jj work. This is the crash trace.

**Versioned payload.** The Record carries `v: 1` so a later schema change can still read old entries.

**Record shape.** Common fields; per-operation fields are trimmed so a Record carries only what its operation has. This shape is the decision:

```ts
{
  v: 1,
  operation: "fold",            // workspace | seed | base | stamp | fold | sync | archive | unarchive | guard
  stage: "done",                // start | done | failed | noop
  trigger?: "auto" | "manual" | "cross-session" | "flush" | "shutdown",
  session: "…",                 // session key
  change?: "…",                 // resulting change id, when known
  input?:    { … },             // the flags / request that led here
  resolved?: { … },             // base, tip, target, bookmark
  result?:   { … },             // subject, rev, marker, pushed, status
  error?:    { code, message },
  diff?:     { files, omitted: [{ path, changes, reason }] },
  generator?:{ model, fallbacks: ["header"] },
}
```

**Operation set.** `workspace` (create / reuse / fail), `seed` (copy / push / pull), `base` (resolve), `stamp` (auto / manual / cross-session / flush, with source `interaction | diff | rev`), `fold`, `sync`, `archive` (command / shutdown auto), `unarchive`, `guard` (blocked tool call / corrected command form). Serve is not recorded.

**Failure detail.** A failed Record carries the failing status code and jj's message, which names the subcommand and includes the exit code and stderr, plus the input that led there. The terminal Record also carries the resolved refs when the operation had resolved them before it failed. No step name is invented where the code does not have one. Full argv is not recorded: the failure message already names the subcommand.

**No per-command tracing.** Individual jj commands stay in the debug log. The Record is per operation invocation, at outcome level.

**Guard policy.** Tool-call blocks and corrected command forms are recorded; routine path redirects into the workspace are not.

**Correlation.** The Record carries the resulting change id when the action produced one. The jj operation id does not exist until after the last command, so it is not stamped inline.

**Write seam.** The core returns a structured diagnostics payload on its Action Result; the adapter merges that with the failure message it already sees on the status sink and calls `pi.appendEntry`. `pi.appendEntry` never moves into the core.

**Ordering.** The terminal Record is written before the Stamp marker advances, so the marker stays the branch's last custom entry and the Interaction cursor is unchanged.

**Diff manifest.** The core diff collector returns the omitted-file list in addition to the assembled prompt text. Today it renders the list into a `diff-condensed` info message and discards it.

**Markers stay markers.** The Base, Stamp, Folded source, and Seed entries keep their own types and their read-back helpers. Records are a separate, observational type. See ADR 0010.

## Testing Decisions

**What makes a good test here.** The observable behavior is "after this operation, the session branch contains a Record saying X". Tests drive the extension through its real entry points and read the session branch. They do not assert on private functions, call counts, or the exact object identity of a payload.

**One seam: the extension integration harness.** The harness already binds `appendEntry` to a real session manager and exposes the branch through `getSessionManager(runner).getBranch()`. Every Record write is observable there, for every operation, with a real jj repo underneath. No new seam is introduced.

**Prior art.** The seed integration test is the model: it drives `session_start` and `/sillajje:seed` through the harness and reads the `sillajje/seed` entry off the branch. The workspace, fold, archive, and stamp integration tests show the same pattern for their operations. `describeJj` already handles a host without jj.

**Core diagnostics tests.** The core returns the diagnostics payload; assert it in the existing core unit tests for fold, diff, and stamp, at the seams those files already use. This extends existing seams rather than adding one.

**Crash case.** Assert the start Record exists after an operation that is made to fail before it completes, using a failing jj call the harness can inject.

## Out of Scope

- A `/sillajje:log` command or any read-back view. The log is opened as a file.
- Per-jj-command tracing in the session file.
- The ChunkEdge package pin and the dev-tree load path. That was a separate diagnostic detour.
- Renaming `Seed record` to `Seed marker` in code. The glossary says Marker; the code rename is a small follow-up, not this spec.
- Serve records.
- Cross-session aggregation, telemetry export, or anything that reads Records from another session.
- Putting Records into the model's context.

## Further Notes

- The decision and its rejected alternatives live in `extensions/sillajje/docs/adr/0010-persist-records-separate-from-markers.md`.
- The glossary entries for **Marker** and **Record** are in `extensions/sillajje/CONTEXT.md`; the spec uses that vocabulary.
- The originating diagnosis is `session-logging.html` in this directory.
