# Long check execution

Type: grilling
Status: resolved
Blocked by: 01

## Question

How does the gate run a check that outlives the interaction, and what does it do when the check hangs?

A `settle` check runs inside `agent_before_settle`, which pi awaits. A check that never returns hangs settlement, so the interaction never stamps.

Open sub-questions:

- **Timeout.** Per-check or per-gate? What is the default (30s, matching `subGenerator.timeoutMs`, or longer because a test suite is not a completion)? What happens on timeout — kill, mark failed, continue?
- **Killing.** A check runs a shell that spawns children (`mise` → `node` → `vitest`). Killing the shell orphans the grandchildren. Process group kill, or accept the orphan?
- **Output.** Capture silently and report at the end, or stream into Progress so the user sees the check working? Progress currently accumulates phases; a streaming tail is a different widget.
- **Parallelism.** Sequential in declared order (predictable, one failure stops the rest), or parallel (fast, interleaved output, shared workspace writes collide)?
- **Abort.** The user hits Escape mid-check. Does the gate abort the check, or let it finish and discard the result? `ctx.signal` exists for nested work owned by an active turn.
- **Background.** May a check outlive the run — start it, let the interaction settle, and apply the result later? That is the only way a five-minute suite fits a two-minute interaction, but it breaks the "answer the agent before it settles" promise.

## Answer

Decided with the user.

**The timeout default is 300s, per check.** 120s was one slow machine away from falsely hanging this repo's own check, which measured 119s ([Measure check cost in a session workspace](06-measure-check-cost-in-a-workspace.md)). A genuinely hung check costs five minutes, not ten. A per-check field rather than a per-gate budget, because a gate budget hides which check hung.

**Output is captured silently and reported at the end.** The phase widget names the running check; the report is the artifact. A live tail would be a new widget for a wall of text nobody reads until it fails.

**Mechanism decisions, with why.**

- Checks run sequentially in declared order. They share one workspace and a check may write ([Trust and workspace safety](05-trust-and-workspace-safety.md)), so parallel checks would race and their output would stop being attributable to one check.
- `pi.exec(command, args, { timeout, signal, cwd })` already provides the mechanism: it returns `{ stdout, stderr, code, killed }` and kills the direct child with `SIGTERM`, then `SIGKILL` five seconds later (`dist/core/exec.js:21-46`). The extension supplies `timeoutMs` and the turn's signal; `killed` distinguishes a timeout from an exit code.
- A timeout marks the check `timed-out`, which is red. A gate that cannot finish is not a gate that passed, and the status is already in the Record vocabulary from [Check vocabulary, Records, and the commit section](04-check-vocabulary-and-commit-section.md).
- Escape mid-check kills the check, and the unfinished checks are recorded as `waived (cancelled)`. The run still settles and stamps — `agent_settled` calls `stampPending(ctx, "auto", event.aborted)` (`index.ts:1200`) and `aborted` only marks the interaction Record. An *already* aborted run never starts the gate; an abort *during* it is a cancellation, not a skip. See [The waiver surface](10-the-waiver-surface.md).
- No background checks. The loop's design is that the result reaches the agent before it settles; a check that outlives the run would be a different feature, and it is recorded as out of scope on the map.

**Accepted risk.** `pi.exec` kills only the direct child, so a killed `mise` can leave vitest workers running. A process-group kill needs its own spawner (`detached: true` plus a negative-pid kill); it is not worth building until a leftover process actually bites. The check's `timeoutMs` is the lever if it does.

**Amendment.** The `timeoutMs` default in [Checks config schema](01-checks-config-schema.md) changes from 120000 to 300000.
