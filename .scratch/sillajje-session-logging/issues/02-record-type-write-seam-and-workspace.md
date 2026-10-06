# 02: Record type, write seam, and Workspace Records

**What to build:** The `sillajje/record` session entry and the seam that writes it, exercised on the Workspace lifecycle. The entry is observational — the extension never reads it back — versioned, and one type with an operation discriminator whose full operation union is declared up front (`workspace`, `seed`, `base`, `stamp`, `fold`, `sync`, `archive`, `unarchive`, `guard`). The seam writes a start Record, runs the operation, then writes a terminal `done`, `failed`, or `noop` Record, and catches a throw so an unexpected failure still leaves a trace. Records never enter the model's context. Later tickets add a payload, not a case in a shared switch.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] A session start writes a start Record and a terminal Record for the Workspace.
- [x] A created Workspace, a reused Workspace, a failed creation, and a create-from-root noop are each distinguishable from the Record.
- [x] An operation that throws still writes a terminal failed Record carrying the message.
- [x] The Record payload carries `v: 1`, the operation, and the stage.
- [x] Records are absent from the model's context.
- [x] The tests read Records off the session branch through the extension integration harness.

## Notes

The seam is `recordOperation(sink, operation, { fields, run, settle })` in `src/record.ts`, with `writeRecord` binding the sink to `pi.appendEntry`. Reused Workspace is `noop`; a created Workspace from `root()` is `done` with `result.fromRoot`. The failed case is the archived-session path (a pre-existing session bookmark); a `jj workspace add` throw is covered by the seam's unit test, not the integration. A test-only `recordsIn` reader was added to the harness (`_helpers.ts`).
