# Serialize per-session commands in the CLI host

Status: ready-for-agent
Type: task

## Context

Recorded from the PR #19 triage of the 13:18 Macroscope review (finding on
`packages/sillajje-core/src/archive.ts:122`). The decision was to defer the fix
and carry the constraint to the host that can hit it.

## The constraint

`createUnarchive` checks `workspaces.isLive(sessionKey)` and then calls
`workspaces.unarchive(sessionKey)`, which runs `jj workspace forget` followed by
`jj workspace add`. Two concurrent calls for one session can both pass `isLive`.
The loser's `forget` unregisters the winner's workspace, and its `add` fails on
the now-populated directory, leaving the session's workspace unregistered.

The pi host serializes command handlers: `prompt()` awaits
`_tryExecuteExtensionCommand`, so two `/sillajje:` commands cannot overlap in one
process. The command handler is not the only entry point the core will have.

## What to do

When the CLI host lands (`.scratch/idea.md`: "create a cli version for using the
command interaction out of pi session"), serialize commands per session before
it calls a core action. A per-session in-flight promise map at the host is
enough. Keep locking out of `@pi-tre/sillajje-core`: the repo's concurrency
stance is that jj coordinates cross-session operations, and this race is a
same-session check-then-act that only a host can order.

## Why not fixed now

No caller can reach it. A lock in the core today would guard a scenario with no
host. The triage decision (Q1, option b) was to defer and record this constraint.
