# The jj boundary exposes typed verbs, not the process

**Status**: accepted

`@pi-tre/sillajje-jj` exposes `Jj`, a typed facade: reads, one `Mutation` write vocabulary applied through `apply`, and a `transaction(recipe)` combinator. The process seam `ExecFn` is internal. Callers never build argv, thread `--at-op`, or parse output.

## Context

The first draft of the package exposed the process call — `ExecFn` — as its port. That left argv construction, deferred-operation chaining, operation-id parsing, and created-commit discovery at every call site, and it made "no direct jj outside the package" a rule enforced by grep. Fold could not be expressed at all: its `squash` range is built from the commits `duplicate` just created, which a static command list cannot name.

## Considered Options

- **Process port (`ExecFn` public).** Callers know jj's CLI. Rejected: shallow, and the boundary is not type-enforced.
- **Static operation list (`run` / `runAll`).** Rejected: cannot express a later step that depends on an earlier step's result.
- **Typed facade with a transaction recipe (chosen).** A closure receives a `Tx` handle, so later steps read earlier results. One `apply` method runs in two contexts: integrated on `Jj`, deferred inside a `transaction`.

## Consequences

- `ExecFn` survives as an internal seam, used by the package's own tests and by the adapter that constructs `createJj(pi.exec)`.
- Failure injection moves from matching argv to naming a Mutation kind.
- The package stays free of pi imports; the adapter is the only caller that names the process.
- The one uncontrolled string is the deferred operation id that jj prints on stderr. It is pinned by a fixture, and a jj version bump re-pins it.
