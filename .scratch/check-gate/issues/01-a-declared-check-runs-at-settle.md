# 01: A declared check runs at settle and records its verdict

**What to build:** A repository declares a check in its project config. When an agent Interaction settles with a change to the working copy, sillajje runs that check inside the session workspace, shows it running, and records the verdict. A passing check is silent; a failing one notifies with its exit code. The verdict is held for the stamp that follows.

This is the tracer bullet: config, core gate, command boundary, adapter binding, session log, and tests, cut end to end.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] The config schema accepts a top-level `checks` array: `name` (required, unique in the array), `command` (required shell string), `triggers` (default `["settle"]`, values `settle` and `publish` only), `timeoutMs` (default 300000), and `paths` (optional, may be ignored until its own ticket). A sibling `maxAttempts` defaults to 5. An unknown trigger value and a duplicate name both fail the config load rather than falling through to a default.
- [x] A check's command runs through the shell with the workspace root as the working directory, the process environment plus a forced `CI=1`, and its configured timeout.
- [x] A check that exceeds its timeout is recorded as `timed-out` and counts as a failure.
- [x] The settle gate runs every check the `settle` Trigger selects, in declared order, and does not stop at the first failure.
- [x] A `checking` phase is emitted per check, carrying the check's name, and renders as progress while the gate runs.
- [x] A gate run writes one Record carrying the invocation trigger and a per-check result (name, status, exit code, duration, reason). No Record per check.
- [x] A green gate is silent. A red gate notifies through the existing error path with the failing check's name and exit code.
- [x] The gate is skipped when the interaction's change is empty and when the run was already aborted.
- [x] Tests: the settle path through the extension integration harness using real shell commands (one that passes, one that fails, one that outlives a short timeout), and the pure selection, ordering, and timeout-mapping logic through the core's port-stub seam.

**Deviation:** `maxAttempts` is a top-level key beside the `checks` array (a JSON array cannot hold a sibling); `CommandPort` names its method `exec` so a Fold can bind it alongside `SubagentPort.run`. Records use the existing start+terminal pair per gate run.
