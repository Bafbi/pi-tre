# Feedback to the agent

Type: grilling
Status: resolved
Blocked by: —

## Question

How does a failed settle-triggered check reach the agent, and what tree does the gate check?

Settled going in: the settle gate fires at `agent_before_settle`, because that is the only seam that can append entries and buy one more provider request. `agent_settled` stays the auto-stamp point and cannot answer the agent.

Open sub-questions:

- **What tree is checked.** At `agent_before_settle` the workspace working copy is dirty and unstamped. Confirm the gate runs there, on the working copy, not on a sealed revision. If it does, the check sees uncommitted state, which is what the agent just wrote.
- **The continuation.** One continuation per interaction, or a budget (`maxRetries`)? What happens when the budget runs out — stamp with the failure recorded (already decided) — and how is that recorded in the transcript?
- **The loop guard.** How does the extension know this interaction already had its check pass? An in-memory flag dies on reload; a Marker survives and follows the existing Marker/Record split. Which one, and what does the marker key on — the interaction, the tree id, or the stamp cursor?
- **What the agent sees.** The full output, a truncated tail, or a structured summary (check name, exit code, last N lines of stderr)? What is the output cap, and does it reuse the sub-generator's diff-budget idea or get its own?
- **Re-running.** After the agent fixes and settles again, does the gate re-run automatically? Is there a `/sillajje:check` manual entry point the agent can call itself?
- **The passing case.** Silence, a footer note, or a Progress phase that vanishes? Today a successful auto-stamp is silent.
- **Aborted runs.** `agent_before_settle` carries `outcome`; a run aborted with Escape should probably skip the gate. Confirm.
- **Concurrency.** `agent_before_settle` handlers are awaited; a multi-minute check blocks settlement. Does that interact with the auto-stamp that follows, or with a queued follow-up prompt?

## Answer

Decided with the user.

**The loop is capped at 5 attempts. It also ends early on green, on a recorded waiver, or on a stall.**

- The gate runs at most 5 times per interaction. Each run executes every check its trigger selects. A red run appends the report and continues while attempts remain; the fifth red settles the interaction and notifies the user that the gate gave up.
- The agent may **waive** the gate after seeing a failure, giving a reason. A waiver ends the loop and settles the interaction. The reason is the artifact; whether the agent can pre-empt the failure, how it asks, and what the waiver records are ticket 10.
- The gate stops early when it makes no progress: if the working copy's diff digest at this run equals the previous run's, the interaction settles red instead of spending another attempt. One red report always gets a chance to act, because the agent cannot fix what it has not seen.

The cap is a backstop for the case nobody can see: a check broken by the environment, or a fix that never converges. The principle is still "we want green" — the budget exists so a chase that cannot succeed ends with a recorded failure instead of an empty wallet. The stall rule is the cheap exit: an agent that explains instead of fixing does not spend the whole budget. The attempt count is `checks.maxAttempts`, default 5, a sibling of the `checks` array; the field belongs to the shape in [Checks config schema](01-checks-config-schema.md).

**Other value calls.**

- The gate is skipped when the current change is empty (`jj diff -r @` is empty). A question answered with no edits costs nothing, and the same signal already drives "nothing to stamp".
- The agent receives the full raw output, truncated exactly like a bash tool call: the last 2000 lines or 50KB, whichever hits first, with a pointer line to the complete output (`dist/core/tools/truncate.js:10-11`, `truncateTail`). The same limits apply for the same reason — the agent is reading a process's output either way.
- A green gate is silent. Progress shows the run while it happens; an Outcome appears only when the interaction settles red.

**Mechanism decisions, with why.**

- The gate checks the workspace working copy at `agent_before_settle`, before the seal. Same tree the stamp is about to describe, and `agent_before_settle` precedes `agent_settled`.
- The stall check needs a content identity, not a revision: `jj` 0.46 has no `tree` template keyword (verified: "Keyword `tree` doesn't exist"), so the digest is taken over the diff text sillajje already reads for stamping.
- The loop state is in-memory, reset at `before_agent_start`, keyed to the interaction: the previous digest, the previous result, the waiver. pi re-enters the boundary after every continuation, so the guard must be extension-owned. A mid-interaction reload resets it and the user can Escape; neither loses work.
- The report is a `custom_message` entry with `display: true`, `customType: "sillajje/check"`, so the user sees exactly what the agent saw (`examples/extensions/file-trigger.ts` is the shape).
- The full output goes to `<workspacesRoot>/<repo-slug>/<session-id>.checks/<check-name>.log`, outside the workspace. A log inside the workspace would land in the stamp's diff.
- An aborted run (`outcome: "aborted"`) skips the gate. Escape is the user stopping the run, not the agent failing it.
- The terminal result (green, waived, or stalled red) is held in adapter state for the `agent_settled` stamp to read. `agent_settled` fires after the boundary, so the transcript is not the carrier.

**Unblocks.** 04 (vocabulary and commit section) and 09 (manual entry point), both of which waited on the report's shape. Surface the waiver as ticket 10.
