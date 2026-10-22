# Map: the sillajje check gate

The spec this map produced is [PRD.md](PRD.md) (`Status: ready-for-agent`). The map below is the decision record behind it.

## Destination

A spec for a check gate in sillajje, plus the ADRs it needs: named checks declared in project config, each assigned to a Trigger (`settle`, `publish`), run inside the session workspace, whose failures are handed back to the agent for a bounded retry and recorded in the stamped change. **Reached:** the spec is [PRD.md](PRD.md) and the build slices are under `issues/`.

## Notes

**Domain.** Every session opens with the `grilling` and `domain-modeling` skills. The glossary in `extensions/sillajje/CONTEXT.md` already owns `Stamping`, `Interaction`, `Fold`, `Record`, `Marker`, `Status event`, `Progress`, `Outcome`, and `Action`. A check slots into that vocabulary; it does not get a parallel one.

**Facts settled before the map.**

- jj has no commit hooks and will not copy git's model. `docs/git-compatibility.md` records "Hooks: No" (jj-vcs/jj#405); `jj git push` passes `--no-verify`. Substitutes are `jj fix` (content transform), `jj run` (a command per revision, in an isolated working copy), and `jj util exec`.
- `agent_before_settle` is the only seam that can answer the agent: it accepts appended entries plus `continue: true`, which buys exactly one more provider request. `agent_settled`, where the auto-stamp fires today, is notification-only.
- Nothing in this repo declares "the checks we want" today. `mise run check` is the fast hermetic gate, `mise run ci` the slow one, and per-module tasks skip unchanged sources.
- Sillajje's `postInit` already runs `mise trust` and `mise deps` in a fresh workspace, so a workspace can run `mise run check`.

**Standing preferences.**

- Never lose work: a red gate still stamps, with the failure recorded. The sillage stays complete.
- Sillajje stays repo-agnostic. The repo names its checks; the extension runs them.
- Prefer a declared list over discovery. Discovery guesses wrong on a monorepo and hides the gate set from review.

**Tracker.** The effort directory holds four things: `PRD.md` (the spec), `map.md` (this index), `decisions/NN-*.md` (the thirteen decision tickets and their reasoning), and `issues/NN-*.md` (the eight build slices, numbered in dependency order). In the decision tickets, `Type:` is the ticket type and `Status:` is `open`/`claimed`/`resolved`; in the build tickets, `Status:` is `ready-for-agent` and `Blocked by:` names the build slices that gate them. The frontier is the build slices whose blockers are all done.

## Decisions so far

<!-- one line per resolved ticket; the detail lives in the ticket -->

- [Precedent for an agent-facing check loop](decisions/08-precedent-for-an-agent-check-loop.md): pi fires `agent_before_settle` on every settle attempt and re-enters it after each continuation, so the loop guard must live in the extension; `examples/extensions/` has no check loop; opencode splits "admit a message" from "start a run" and makes the append idempotent by id.
- [Checks config schema](decisions/01-checks-config-schema.md): a top-level `checks` array; `{name, command, triggers, timeoutMs}`; a shell string run with `sh -c`; no trigger named means `settle`; a gate runs every selected check and reports every failure.
- [Feedback to the agent](decisions/02-feedback-to-the-agent.md): capped at 5 attempts per interaction; ends early on green, a waiver with a reason, or a stall (same diff digest twice); skipped when the change is empty; the agent gets the raw output truncated exactly like a bash call; green is silent.
- [Fold publish gate](decisions/03-fold-publish-gate.md): red blocks the Fold before the transaction opens; `--no-check` overrides and records the override; the checked tree is the source workspace's working copy; no live workspace refuses the fold unless `--no-check`.
- [Check vocabulary, Records, and the commit section](decisions/04-check-vocabulary-and-commit-section.md): a `Checks:` line on every stamp and fold (green included, name + verdict + duration, no command); one Record per gate run; `PhaseCode` gains `checking`; the glossary now owns `Check`, `Gate`, `Trigger`, `Check report`, and `Waiver`.
- [Trust and workspace safety](decisions/05-trust-and-workspace-safety.md): both config layers may declare checks (project replaces global); the environment is the process env plus a forced `CI=1`; a check may write, and its edits land in the same interaction's stamp.
- [Measure check cost in a session workspace](decisions/06-measure-check-cost-in-a-workspace.md): `mise run check` is 119s after one module changes, 5.6s when everything is cached, and a failed run poisons mise's cache; the suite is flaky (`seed.test.ts:91` 5s timeout) and `mise run ci` is permanently red on `type-aware` (6 warnings, empty baseline).
- [Long check execution](decisions/07-long-check-execution.md): `timeoutMs` defaults to 300s per check; output is captured silently and reported at the end; checks run sequentially in declared order; a timeout is red; Escape kills the check and records the unfinished ones as `waived (cancelled)`.
- [The waiver surface](decisions/10-the-waiver-surface.md): a `waive_checks` tool, declared whenever checks exist, refusing anything but the current failure; the reason lands in the `Checks:` line, the Record, and a warning; Escape is the user's waiver (`waived (cancelled)`) and the interaction still stamps.
- [Manual check entry point](decisions/09-manual-check-entry-point.md): `/sillajje:check` runs every declared check (`--trigger` narrows), reports a red result and stops, starts no turn, and gives the agent no check tool; the `manual` trigger value is dropped — `triggers: []` already means on demand.
- [Settle gate composition](decisions/11-settle-gate-composition.md): a check takes a `paths` glob filter (no match means `skipped`); this repo runs `mise run check` on both `settle` and `publish` and accepts 119s; no `retries`, no known-red baseline; manual stamps and degenerate workspace states never reach a settle Gate.
- [Check visibility outside the commit](decisions/12-check-visibility-outside-the-commit.md): no check outcome in the header sub-generator, and no gate state in the footer pill; the `Checks:` line and the Outcome are the only reports.
- [Where the gate lives](decisions/13-where-the-gate-lives.md): one gate run is a core `check` module behind a new `CommandPort`; the 5-attempt loop, the stall digest, the waiver tool, and the report live in the adapter; Fold calls `runGate` itself.

**The map is clear.** Every ticket is resolved and every fog patch is decided. What is left is the build, which is a fresh effort reading these tickets.

## Not yet specified

None. Every fog patch graduated to a ticket and every ticket is resolved.

## Out of scope

- **A jj-native hook mechanism, or parity with git's pre-commit hooks.** jj has none by design (jj-vcs/jj#405) and its push path runs `--no-verify`. The gate lives at pi's interaction boundary.
- **`jj run` across a revision range.** A retroactive audit of a whole stack is a different capability, not this destination.
- **`jj fix` as a formatting transform.** A content rewrite, not a gate.
- **A check that outlives the run.** Backgrounding a check and applying its result later breaks the one promise the loop makes — the failure reaches the agent before it settles. A different capability.
