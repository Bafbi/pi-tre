# Persist records in the session log, separate from markers

Every operation the adapter drives writes **Records** to the session log through `pi.appendEntry` — a start record, then a terminal done, failed, or noop record — so a failed, crashed, or surprising run can be diagnosed after the fact. Records are observational and separate from **Markers**: a Marker is read back to decide behavior (a cursor, a base handoff, a seed drift check), a Record is never read by the extension. Per-jj-command tracing stays in the debug log.

## Considered Options

**Unify markers and records under one custom type (rejected).** The Stamp marker is a cursor and the Base marker is a handoff; routing behavioral reads through a diagnostic stream makes behavior depend on logging.

**Record every jj command (rejected).** A fold runs roughly eight jj commands; that trace belongs in the debug log, not the session file.

**One terminal record per operation (rejected).** A process that dies mid-operation leaves no terminal record, and `debug` is off by default, so a crash leaves no persisted trace. A start record carries the input and the resolved refs across the crash.

**Extend the debug log only (rejected).** `debug` defaults off (`packages/sillajje-core/src/config.ts`), so a failed fold leaves no persisted trace and a rejected session leaves no reason.

**A separate observational Record type (chosen).** One `customType` with an operation discriminator, written by the adapter at each operation's outcome.

## Consequences

- The reader is the session file itself; no `/sillajje:log` command is in scope.
- `Seed record` (`extensions/sillajje/src/seed.ts`) is behavioral, so it is a Marker and should be renamed `Seed marker` to match the split.
- The diff manifest can only be persisted if `collectDiff` returns the omitted list; today it renders the list into a `diff-condensed` message and discards it (`packages/sillajje-core/src/diff.ts`).
- The core returns enough for the adapter to build a Record; the core never imports pi, so `pi.appendEntry` stays in the adapter.
