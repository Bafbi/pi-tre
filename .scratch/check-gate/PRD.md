Status: ready-for-agent

# Check gate for sillajje

## Problem Statement

A sillajje session stamps every Interaction as a jj change, so the history is complete, but nothing proves the work in a change is sound. The agent decides when it is done, and the only signal that the code still compiles, lints, or passes its tests is whether the agent happened to run those commands — and a `bash` run leaves no trace in `jj show` and no obligation on the next turn.

Git users solve this with a pre-commit hook. jj has none, by design, so there is nothing at the version-control layer to hook into. Worse, a hook would run after the agent stopped caring: it could block a commit, but it could not tell the agent what broke while the agent still had the context to fix it.

The user is left maintaining a good codebase by hope: hoping the agent ran the tests, hoping the run was the current tree, hoping nobody skipped a failing step under time pressure.

## Solution

A declared check gate at sillajje's interaction boundary.

A repository declares its checks in sillajje's project config: named shell commands with a timeout, an optional path filter, and one or more Triggers. Sillajje runs them at the moments that matter.

- **At settle**, before the Interaction is stamped: if the checks fail, the agent receives the raw output and one more turn to fix them. The loop is capped at five attempts, ends early when the agent stops making progress, and ends immediately when the agent waives a failure with a reason it cannot fix.
- **At publish**, before a Fold's transaction opens: a failing check blocks the publish, and `--no-check` overrides it in the record.
- **On demand**, through `/sillajje:check`: run everything now, read the report, ask the agent to fix it.

Every stamped change then carries a `Checks:` line saying what ran and what it said — including when a check was waived and why. The sillage becomes reviewable not just as a record of what was done, but as a record of what was verified.

## User Stories

1. As a repository owner, I want to declare my checks once in project config, so that every sillajje session in this repo runs the same gate.
2. As a repository owner, I want a check to be a plain shell command, so that I can use the orchestrator I already have rather than learn a new plugin format.
3. As a repository owner, I want a check to name the workspaces root as its working directory, so that `mise run //extensions/x:check` resolves the way it does in my terminal.
4. As a repository owner, I want checks to inherit my environment, so that credentials and tool paths already configured for the shell keep working.
5. As a repository owner, I want `CI=1` forced in a check's environment, so that a tool that would prompt fails fast instead of hanging until the timeout.
6. As a repository owner, I want to assign a check to `settle`, to `publish`, to both, or to neither, so that a fast check runs constantly and an expensive one runs before anything leaves the workspace.
7. As a repository owner, I want a check with no trigger to default to `settle`, so that declaring a check means it runs.
8. As a repository owner, I want a check with an empty trigger list to run only when asked, so that I can keep a check declared without paying for it on every interaction.
9. As a repository owner, I want a per-check timeout defaulting to five minutes, so that a hung check cannot hang an interaction forever.
10. As a repository owner, I want to filter a check by path globs, so that a suite runs only when the diff touches the code it covers.
11. As a repository owner, I want a path-skipped check reported as skipped rather than passed, so that the commit never claims a check ran when it did not.
12. As a repository owner, I want a global checks list that a project's list replaces, so that my personal default applies everywhere except where a repo has its own opinion.
13. As a repository owner, I want an untrusted project's checks never to run, so that cloning a stranger's repo cannot execute their commands.
14. As a repository owner, I want a check to be allowed to write to the workspace, so that a formatter or codegen check is a legitimate check.
15. As a repository owner, I want a check's writes to land in the same Interaction's stamp, so that the committed tree is the tree that passed.
16. As a repository owner, I want the `Checks:` line to say when the gate itself moved the tree, so that I know the change contains edits nobody in the conversation made.
17. As a repository owner, I want the `Checks:` line on every stamp, green or red, so that a reviewer can tell "verified" from "nothing ran".
18. As a repository owner, I want the `Checks:` line to name the check, its verdict, and its duration, without the command or the output, so that commit bodies stay readable.
19. As a repository owner, I want a Fold to carry the same `Checks:` line, so that a published change says what validated it.
20. As a repository owner, I want no known-red baseline inside the gate, so that a repo cannot declare a permanently failing check as acceptable.
21. As an agent, I want to be told, before the session ends, that a check failed, so that I can fix it while I still have the context.
22. As an agent, I want the raw output of the failing check, truncated the way a `bash` result is truncated, so that I read what the tool actually said rather than a summary of it.
23. As an agent, I want a pointer to the complete output when it is truncated, so that I can read the whole log.
24. As an agent, I want every failing check reported in one pass, so that I fix everything in one turn instead of one failure per turn.
25. As an agent, I want the gate to stop asking when my last attempt changed nothing, so that I am not pushed to keep trying a fix that is not converging.
26. As an agent, I want to waive a check that I cannot fix, naming the reason, so that a failure caused by the environment does not trap the interaction.
27. As an agent, I want to waive specific checks rather than the whole gate, so that the checks I did fix stay green in the record.
28. As an agent, I want my waiver refused when nothing is failing, when the check I named is not failing, or when I gave no reason, so that the tool cannot be used to skip work.
29. As a user, I want a passing gate to be silent, so that a normal interaction looks exactly like it does today.
30. As a user, I want Escape during a running gate to stop the check, so that I can cancel a run I already know is not worth waiting for.
31. As a user, I want Escape during a gate to keep my work, so that cancelling the checks still stamps the interaction.
32. As a user, I want a cancelled gate recorded as waived with "cancelled" as the reason, so that the commit says the verification was cut short rather than never attempted.
33. As a user, I want a red gate to stamp anyway, so that sillajje never drops an Interaction because a check failed.
34. As a user, I want the gate capped at five attempts, so that a chase that cannot converge ends with a recorded failure instead of an empty wallet.
35. As a user, I want the report to appear in the transcript, so that I can read what the agent read.
36. As a user, I want `/sillajje:check` to run everything now, so that I can call for verification without waiting for the agent to settle.
37. As a user, I want `/sillajje:check --trigger publish` to run only the publish gate, so that I can rehearse a Fold before publishing.
38. As a user, I want `/sillajje:check -s <id>` to run another session's checks, so that I can verify a session from another conversation.
39. As a user, I want `/sillajje:check` on a session with no live workspace to refuse, so that it never invents a temporary checkout to pass.
40. As a user, I want `/sillajje:check` to report and stop rather than start an agent turn, so that a command never spends tokens on my behalf.
41. As a user, I want a failing publish gate to block a Fold, so that a broken change cannot be published by accident.
42. As a user, I want `--no-check` to override a publish gate, so that an environmental failure does not block publishing forever.
43. As a user, I want a `--no-check` Fold recorded as waived, so that the published change says it went out unverified.
44. As a user, I want a Fold of a revision or an archived session to refuse when a publish check exists, so that "no checks ran" is never silent.
45. As a user, I want a Fold that the gate refused to advance no marker, so that fixing the failure and folding again publishes the same delta.
46. As a user, I want the gate skipped when the interaction changed nothing, so that answering a question costs nothing.
47. As a user, I want a Record for each gate run, so that I can diagnose a surprising verdict after the fact.
48. As a user, I want the gate's progress shown as a phase per check, so that I know which check is running.
49. As a user, I want a terminal red gate to notify me, so that I am not surprised by a failed stamp.
50. As a maintainer, I want the check vocabulary in the glossary, so that the code, the config, and the commit body use one set of words.
51. As a maintainer, I want one gate run to be a pi-free core capability, so that the Fold action and the settle loop share the same implementation.
52. As a maintainer, I want the command boundary to be a port, so that the core never learns how the adapter spawns a process.

## Implementation Decisions

**Config.** A top-level `checks` array of objects beside the existing `seed`, `postInit`, and `vcsGuard` keys — not under `actions`, which is for body-producing actions. Fields: `name` (required, unique within the array), `command` (required, a shell string), `triggers` (array of `settle` | `publish`, default `["settle"]`, `[]` meaning on demand only), `timeoutMs` (default 300000), `paths` (optional glob list). A sibling `checks.maxAttempts` (default 5) holds the loop budget. The schema is owned by the core, is regenerated into the published JSON schema, and rejects an unknown trigger value rather than falling through to the default.

**No `manual` trigger.** Asking for a check is the check command, not a Trigger, so the vocabulary has exactly two trigger values. A check that should run only on demand uses `triggers: []`.

**No `enabled`, `cwd`, `env`, `stopOnFailure`, or `retries` fields.** Disabling is deleting the check or emptying its triggers; the working directory is always the session workspace; the environment is inherited with `CI=1` forced; running every selected check is gate policy, not check config; and a retrying gate would hide flakiness.

**Command execution.** `command` is a shell string run through `sh -c` with the workspace root as cwd and the process environment plus a forced `CI=1`. This mirrors the existing `postInit` execution and carries the same justification for the repo's `no-shell-c` rule. Checks run sequentially in declared order; a failing check does not short-circuit the rest, because the loop's budget is one report and a partial report costs a whole extra turn.

**The gate is one core run plus an adapter loop.** The core gains a pi-free `check` capability that executes one gate run: it selects checks by Trigger, applies the path filter against the interaction's diff, runs them in order, emits a `checking` phase per check, maps a timeout to a red `timed-out`, and returns per-check results. The core gains a `CommandPort` (run a command string with a cwd, timeout, and abort signal, returning exit code, streams, and a killed flag) alongside the existing host ports. The adapter binds that port to pi's process execution, and owns everything that depends on pi: the attempt loop, the diff digest, the waiver tool, the transcript report, and handing the verdict to the stamp. The Fold action calls the same core gate itself, so a refusal is an ordinary failed Fold result.

**Settle loop.** The gate runs at the settle boundary on the current session's workspace. It is skipped when the run is already aborted and when the interaction's change is empty. A red result appends a Check report as a displayed custom message and continues the run, at most five gate runs per Interaction; the fifth red settles. A red result also settles immediately when the interaction's diff digest is unchanged from the previous attempt (the stall rule). A waiver settles immediately. The terminal verdict is held in adapter state for the stamp that follows.

**Report.** The failing checks' raw output, truncated to the last 2000 lines or 50KB, whichever comes first, with a pointer line naming the complete output file. The full output lives outside the workspace, so it never enters a stamp's diff. A green gate reports nothing.

**Waiver.** A `waive_checks` tool taking `{ reason, checks? }`. It is registered only when the config declares checks, and is declared from the start rather than activated on demand, because mid-run tool changes cost a full prefix checkpoint on most providers and nothing on a few. It refuses — with a failed tool result naming the current failure set — when no gate is red, when a named check is not failing, or when the reason is empty. `checks` defaults to every failing check. The waiver is a verdict on one tree at one moment: it does not persist, does not change config, and does not relax a publish gate.

**Escape.** A running gate passes the turn's abort signal to the check. On abort the check is killed and the unfinished checks are recorded as waived with reason `cancelled`. The interaction still settles and stamps; the existing abort path already stamps and only marks the interaction record.

**Commit body.** A `checks` section joins the stamp's and the fold's body vocabularies, rendering after `Trace` and after `Ref` respectively, selected by the existing body-order config. It renders one line, lists only the checks that ran for that Trigger, and names each check with its verdict and duration — no command and no output. A green run renders; a gate that ran no checks, or was skipped, renders nothing. A waived check renders with its reason; a `--no-check` Fold renders the flag as the reason.

**Records and status events.** One Record per gate run, not per check: the operation is `check`, with the invocation trigger, the attempt number, the diff digest, and a per-check array of name, status (`passed`, `failed`, `timed-out`, `waived`, `skipped`), exit code, duration, and waiver reason. The status vocabulary gains a `checking` phase carrying the check name as its target; a terminal red emits an error status and a waiver emits a warning, both of which the adapter already renders.

**Publish gate.** The publish gate runs once, before a Fold's transaction opens, against the source workspace's working copy, because the folded change exists only inside the transaction. It never loops: a Fold's caller is the user. A red result returns a failed Fold result, and nothing is published or marked. `--no-check` overrides it and is recorded. When a publish check exists but the source has no live workspace — a revision source, an archived session, a missing workspace — the Fold refuses and names the flag. A repo that declares no publish check folds such a source as it does today.

**Manual command.** `/sillajje:check` runs every check the target workspace declares, `--trigger` narrows to one gate, and `-s` selects a session target with the existing session-target rules. It reports into the transcript as a displayed custom message without starting a turn, adds an informational outcome on green and a warning on red, and writes a Record with the `manual` invocation trigger. It does not seed or cache the settle gate.

**Not reported elsewhere.** The header sub-generator is not told the gate's outcome, and the status pill keeps reporting session state only.

**Vocabulary.** The glossary gains `Check`, `Gate`, `Trigger`, `Check report`, and `Waiver`. `Trigger` is the check's declared selector; the Record's existing invocation-trigger field keeps its own meaning and takes `settle`, `publish`, or `manual`.

**This repository's configuration.** One check named `check`, running the repository's own gate command, on both `settle` and `publish`. The slower CI command stays undeclared until its known-red type-aware scan is clean.

## Testing Decisions

A good test here drives the feature at its highest seam and asserts external behavior: what the user sees in the transcript, what lands in the commit description, what the session log records, and what the gate asks the agent to do next. It does not assert internal call order, private state, or the shape of intermediate objects. A test names a real behavior in its title ("a red settle gate continues the run and stamps with the failure"), never "calls runGate with three checks".

**Primary seam — the extension integration harness.** The existing harness loads the real extension into a real pi runner with a real session manager, a real jj repository, and a real session workspace, injects test-only ports, and drives events the way pi dispatches them. This is the highest seam in the codebase and the one that proves the loop, so nearly every behavior belongs here: the settle gate green, red, stalled, capped, and waived; the report reaching the transcript; the `Checks:` line in the stamped description; the Record written; Escape cancelling a running check; the publish gate blocking a fold and `--no-check` letting it through; the refusals for a revision source and an archived session; the manual command on a live session and its refusal on one without a workspace; the path filter skipping a check; the empty-change skip.

Checks in these tests are tiny real shell commands (`true`, `false`, a script that prints and exits non-zero, one that sleeps past a short timeout), not stubs. The behavior under test includes process execution, so stubbing it would test the stub.

**Supporting seam — the core's port-stub tests.** Every core capability already has a unit test file with fake ports. The core check capability gets the same treatment for the logic that would otherwise need a repository and a process per case: trigger selection, declared order, the path filter's matching rules, the status mapping for a timeout versus a non-zero exit, and the "no checks selected means nothing ran" case. This is the one place where the core's fake `CommandPort` is exercised directly.

**Reused seam — the config schema tests.** The existing core config tests extend to the new fields: defaults for triggers, timeout, and attempts; rejection of an unknown trigger value; rejection of a duplicate name.

**Prior art.** The integration tests for stamping, folding, and seeding are the model for the loop and commit-body assertions; the core fold and stamp tests are the model for the port-stub style; the config test file is the model for schema assertions.

**Seam confirmation.** The proposal is two new seams and one reused seam. A stricter reading would put everything through the integration harness alone, at the cost of a jj repository and a process spawn for each pure-logic case; a looser reading would unit-test the adapter loop with a fake boundary, which cannot show that pi continues the run.

## Out of Scope

- Parity with git's pre-commit hooks, and any hook inside jj. jj has none by design and its push path disables git's.
- A `jj run`-style audit of a revision range, and `jj fix` as a formatting transform.
- Checks that outlive the interaction: backgrounding a check and applying its result later.
- A user-facing flag that accepts a waiver from the command line.
- Per-check retries, and a known-red baseline the gate consults.
- A tool that runs checks mid-interaction, and any check state in the header or the footer pill.
- Fixing this repository's red `type-aware` scan and its flaky seeding test. Both are repository problems the gate surfaces, not gate features.
- A completion or prompt surface for the manual command beyond running and reporting.

## Further Notes

**The decision record.** The design was settled across thirteen tickets under the same effort directory, each holding one decision and its reasoning: config shape, the feedback loop, the publish gate, the commit and Record vocabulary, trust and workspace safety, a cost measurement of the repository's own gate, long-running execution, precedent from other harnesses, the manual entry point, the waiver surface, settle-gate composition, visibility, and module placement. Where this spec compresses, the ticket has the argument.

**Measured cost.** In a real session workspace of this repository, the full gate takes about two minutes after one module changes, and about six seconds when every module skips. A failed run is not cached, so each attempt pays full price. One fix round therefore costs roughly two runs; the five-attempt cap is a ceiling for a fix that never converges, and the stall rule and the waiver cut it short first.

**Known repository red.** The repository's full CI task fails on a type-aware lint scan and its seeding integration test has a five-second timeout that trips under load. The gate is expected to surface both in its first weeks. Neither justifies a gate feature.
