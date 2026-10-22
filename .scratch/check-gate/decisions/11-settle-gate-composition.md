# Settle gate composition

Type: grilling
Status: resolved
Blocked by: —

## Question

Given that `mise run check` costs 119s in the one module this repo edits most, what belongs behind `settle`?

[Measure check cost in a session workspace](06-measure-check-cost-in-a-workspace.md) produced the numbers: lint plus typecheck cost 1.3s per module, sillajje's integration suite costs 110s, the root-only tasks cost 5.6s even when everything skips, and a failed run poisons mise's task cache so the next attempt pays full price.

This is a design question, not a config question. The config can already express "run X on settle", but nothing in the design yet decides what a reasonable settle gate *is*, or gives a repo a way to say "only the modules my diff touched".

Open sub-questions:

- **Is a slow settle gate acceptable at all?** Sillajje's promise is one stamp per interaction. Two minutes of stalling per interaction changes how the tool feels. The counter-argument: a gate that does not catch what you care about is decoration.
- **A path filter per check.** Does a check get a `paths` field (globs) so it only runs when the diff touches matching files? That would let this repo run `//extensions/sillajje:check` only when that module changed, and `//packages/sillajje-core:check` when core changed. It is a schema change on top of [Checks config schema](01-checks-config-schema.md).
- **A fast/full distinction inside one check.** `mise run check` already skips unchanged modules, so its cost is already path-scoped — except the root-only 5.6s and the expensive module when it *is* the changed one. Is there a cheaper declared check (`mise run lint`, `mise run typecheck`) that should be the settle gate, with the full suite on `publish`?
- **What this repo declares.** Three plausible configs: settle = typecheck + lint (about 1.3s per changed module), settle = `mise run check` (119s), settle = nothing, publish = `mise run check`. Which one, and does the answer belong in this repo's `.pi/configs/sillajje.json` as part of the spec?
- **The flaky test.** `seed.test.ts:91` exceeds vitest's 5s default under load. Does the design tolerate a flaky settle check (the waiver absorbs it), or does a flaky check mean the repo should not put that suite on `settle`?
- **A known-red tree.** `mise run ci` is permanently red on `type-aware`. Does a check have a way to express "this is expected red on this tree" (the repo's `check-baseline.txt` idea), or is that out of scope and the answer is "do not gate on it"?

## Answer

Decided with the user.

**A check gets a `paths` filter.** `paths: string[]` of globs, matched against the diff manifest sillajje already reads. No path matches means the check is `skipped`, not `passed`. This repo does not need it — mise already skips unchanged modules — but a repo whose check is a plain `npm test` would otherwise pay the full suite on a docs change, and the matching plumbing already exists for `subGenerator.diff.omit`.

**This repo runs `mise run check` on `settle`.** The user's principle: the gate exists to keep the code good at every moment, so the settle gate runs the real gate, not a cheaper subset. The measured cost (119s) is accepted.

Two consequences, recorded so they are not surprises:

- `mise run check` begins with `//:format`, which writes. A settle gate therefore reformats the tree, and those edits land in the same interaction's stamp — which [Trust and workspace safety](05-trust-and-workspace-safety.md) already permits and `Checks:` already announces.
- The cost of a red gate is one extra run per fix round, not five runs. Attempt 1 is red, the agent reads the report and fixes, attempt 2 is green: about four minutes of checking for that interaction. Each attempt costs the full 119s only because mise caches a task on success, so a failed run pays full price again. The ~10-minute figure is the ceiling for a fix that never converges, and two things cut it short first: the stall rule (same diff digest twice settles red after one repeat) and the agent's own waiver.

**No baseline for a known-red command.** A check is green or red; a repo must not declare a red command. The 6 `type-aware` warnings in `mise run ci` are a repo fix, and the gate is what makes that state visible rather than permanent.

**Mechanism decisions, with why.**

- No `retries` field. A retrying gate hides flakiness; the `seed.test.ts` 5s timeout is a test problem and the repo raises its timeout.
- A path-skipped check reports `skipped`, never `passed`, so the `Checks:` line cannot claim a run that never happened.
- The empty-change skip from [Feedback to the agent](02-feedback-to-the-agent.md) runs first, so an interaction with no edits never reaches path matching.

**What this repo declares.**

```json
"checks": [
  { "name": "check", "command": "mise run check", "triggers": ["settle", "publish"] }
]
```

`ci` stays undeclared until `type-aware` is green; when it is, it joins `publish`. The publish Gate re-runs `check` because a Fold can publish a range of older interactions, or another session's.

**When the gate does not run.** The settle Gate is bound to `agent_before_settle`, so a path that never passes through it has no settle Gate, and that is the answer rather than a gap:

- `/sillajje:stamp -s <id>` on another session, and `/sillajje:stamp -r <rev>`, are manual stamps. They describe a revision; there is no interaction settling, so no settle Gate runs. A user who wants the checks can run `/sillajje:check` first.
- An archived session, a missing workspace, or a repo where `jj` left PATH cannot run a command at all. The existing guards in the `agent_settled` handler already return before stamping in those states, so the Gate inherits their behavior: nothing runs, nothing is claimed.
