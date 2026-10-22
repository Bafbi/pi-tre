# The waiver surface

Type: grilling
Status: resolved
Blocked by: —

## Question

The agent may end a red gate by waiving it with a reason. How does it ask, what does the answer record, and who else may waive?

Settled going in: a waiver ends the loop and settles the interaction; the reason is the artifact. The gate is capped at 5 attempts, so a waiver is how an agent stops short of spending the budget on a failure it believes it cannot fix — and leaves a reason a reviewer can read.

Open sub-questions:

- **How the agent asks.** A registered tool is the obvious surface, but it adds a tool to every session's prompt. A tool that is only *active* after a red report would keep the prompt clean for the common case — `pi.setActiveTools()` can add it at the boundary and remove it at settle. Is a tool right at all, or should the agent write a file (no prompt surface, but invisible and non-obvious)?
- **When it may ask.** Only after a red report, or pre-emptively? The stall rule already lets an agent escape by changing nothing, so a pre-emptive waiver buys little. Restricting to after-a-failure is a tight rule that is easy to explain and easy to enforce — but a check whose brokenness is known only from documentation would benefit from pre-emption.
- **Granularity.** Waive the whole gate, or name the checks waived? A missing database breaks the integration check while the unit checks stay fixable. Naming checks makes the record more useful and the waiver more honest; it also means the agent must read the report carefully.
- **What it records.** The reason is the point. Where does it surface: the `Checks:` section of the stamp (ticket 04 owns that shape), a Record, the Outcome notification, or all three? A waiver that only lives in a session log is not reviewable in `jj show`.
- **Who else may waive.** The user, through `/sillajje:check --accept <reason>`, or only the agent? A user waiver has to survive the next settle attempt, so it needs the same state the agent's waiver uses.
- **What it does downstream.** Does a waived gate count as a passing gate for a Fold's `publish` trigger? A publish gate waived by the agent is a different act from one waived by the user.
- **The vocabulary.** `Waiver`? `Accept`? `Override`? The glossary forbids a second word for an existing thing; the git world calls this `--no-verify`, and jj has no word for it.

## Answer

Decided with the user.

**The agent's waiver is a tool, declared from the start, that refuses anything but the current failure.** `waive_checks` is registered only when the config declares at least one check, so a repo with no checks pays nothing. It takes `{ reason: string, checks?: string[] }`; `reason` is required and non-empty; `checks` defaults to every check that failed in the current report. When no gate is red, when a named check is not failing, or when the reason is empty, the call throws and the failed tool result names the current state — what is pending, what actually failed.

**Why not activate it on demand.** pi exposes the capability per model: `compat.supportsMidConvoToolChanges` (set by 7 model entries, all `api.anthropic.com`) and `compat.supportsMidConvoToolAdditions` (6), both defaulting to false (`dist/bundle/chunks/anthropic-messages-*.js`). When the flag is false the provider receives a complete transcript checkpoint, which invalidates the cached prefix. A mid-run tool change would therefore cost a full cache write on most providers and nothing on a few. An always-declared tool costs roughly 200 tokens of cached prefix per request and never risks it. Not branching on the flag keeps one code path, and the interesting failure mode — the model calling the tool to escape a loop — is handled by the refusal, not by hiding the tool.

**What it records.** The reason verbatim, length-capped, in three places: the `Checks:` line ([Check vocabulary, Records, and the commit section](04-check-vocabulary-and-commit-section.md)), the gate's Record (`status: "waived"` with the reason), and a `warning` Outcome. The publish gate is untouched: a waiver is a verdict on one tree at one moment, not a standing property of a check.

**What it does.** Ends the loop and settles the interaction. No continuation, no second run, no persistence across interactions, no config change.

**The user has no separate surface, and that is deliberate.** The situations are thin: the 5-attempt cap already stops a loop, a publish gate already has `--no-check`, and a manual check runs outside any interaction, so there is no red gate to accept. What a user actually does is steer — "waive it, no DB here" — or press Escape.

**Escape is the user's waiver.** A running gate passes `ctx.signal` to `pi.exec`, the check dies, and the unfinished checks are recorded as `waived (cancelled)`. The interaction still settles and stamps: `agent_settled` calls `stampPending(ctx, "auto", event.aborted)` (`index.ts:1200`) and `aborted` only marks the interaction Record. An *already* aborted run never starts the gate; an abort *during* it is a cancellation, not a skip.

**Rejected.** An on-demand activated tool (a cache cliff on most providers for a rare act); a file-based waiver (invisible, and it would land in the tree); a user `--accept` flag (no situation that steering or Escape does not serve better).
