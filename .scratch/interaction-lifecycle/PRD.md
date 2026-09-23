# Interaction lifecycle: the session log is the source of truth

Status: ready-for-agent

## Problem Statement

Today the rules that decide when an Interaction ends and becomes a Session stamp live in five pi event handlers and a mutable session-state holder. A reader who asks "why didn't this Interaction stamp?" must trace the handlers, the pending-finalize flags, and the transcript accumulation to find the answer.

The model also disagrees with pi. Pi drains a steering or follow-up prompt into the same run and never fires `before_agent_start` for it, but the extension treats a follow-up as a separate run in places, and its integration tests hand-sequence events to match the internal branching rather than pi's real order. The rule that defers an error-ended run until the true end is subtle, and it is only exercised end-to-end.

## Solution

Sillajje derives the Interaction lifecycle from pi's session log instead of tracking it in memory. The Session stamp fires on `agent_settled`, the point after retries, compaction, and queued continuations. The Interaction transcript is read from the session branch, and a Stamp marker records how far the log has already been stamped. The state holder's interaction fields and the whole defer machinery disappear.

A maintainer can now answer "why didn't this Interaction stamp?" from one pure function. A user gets one jj change per Interaction, including a follow-up that pi folds into the same run, and an Interaction is not lost across a reload or a branch navigation.

## User Stories

1. As an agent user, I want each Interaction to become exactly one jj change, so that the sillage is a faithful trail of my session.
2. As an agent user, I want a follow-up prompt to fold into the current Interaction, so that a change matches the run pi actually performed.
3. As an agent user, I want a steering prompt to fold into the current Interaction, so that an interjection does not split the change.
4. As an agent user, I want a run that auto-retries after a transient error to produce one change, so that a retry does not seal a partial Interaction.
5. As an agent user, I want a run that ends in a final error to produce one change at settle, so that the work is not left un-stamped.
6. As an agent user, I want an Interaction that completes but is never retried to be stamped at session shutdown, so that nothing is lost on quit.
7. As an agent user, I want a reload in the middle of a session to preserve the stamp position, so that the next Interaction does not duplicate or drop a change.
8. As an agent user, I want navigating the session tree to keep the stamp position correct for the new branch, so that a branch does not re-stamp its ancestors.
9. As an agent user, I want a manual `/sillajje stamp -s @` to consume the pending Interaction, so that the next auto-stamp does not seal it again.
10. As an agent user, I want a failed auto-stamp to notify me and leave the work in the working copy, so that I can recover with a manual stamp.
11. As an agent user, I want a stamp failure to advance the stamp position, so that the extension does not loop on a permanent failure.
12. As a reviewer, I want a change's `Meta:` section to record the Interaction's session entry range, so that I can map the change back to the session log.
13. As a reviewer, I want a change's `Meta:` section to record the stamped revision, so that the marker and the change agree.
14. As a maintainer, I want the lifecycle rule in one pure function over session entries, so that I can test it with fixtures and no runner.
15. As a maintainer, I want the adapter handlers to be thin routers that translate pi events into calls, so that the interesting behaviour is not spread across five call sites.
16. As a maintainer, I want the pending-finalize flags and the transcript accumulator deleted, so that there is one way to know when an Interaction stamps.
17. As a maintainer, I want the integration tests to assert observable outcomes, so that a refactor does not break tests that only assert internals.
18. As a maintainer, I want the tests to drive the real pi event order, so that the suite does not lock in an order pi never produces.
19. As a maintainer, I want the glossary to define Interaction as the session-level run, so that the language matches the model.
20. As a maintainer, I want an ADR recording the decision and its rejected alternatives, so that the next reader does not re-propose the state machine.
21. As a maintainer, I want the extension to keep working on the pinned pi version, so that the change does not force an upgrade.
22. As a maintainer, I want the projection to stay in the extension, so that the pi-specific entry shape does not leak into the core.
23. As a maintainer, I want the core stamp action's input unchanged, so that the adapter still owns the pi-shaped seam.
24. As a maintainer, I want a missing or dead workspace to skip stamping at settle, so that a broken session does not error repeatedly.
25. As an agent user with an archived session, I want prompts to be blocked and no stamp to fire, so that an archived session stays retired.

## Implementation Decisions

**The lifecycle moves to a new interaction module in the sillajje extension.** The module exports one pure function, `projectInteraction`. It takes the session branch and the cursor and returns the Interaction's derived data plus its entry range, or `undefined` when the slice has no complete Interaction. This shape came from a prototype and encodes the decision:

```ts
type InteractionProjection = {
  interaction: InteractionData;
  firstEntryId: string;
  lastEntryId: string;
};

function projectInteraction(
  branch: SessionEntry[],
  cursorId: string | null,
): InteractionProjection | undefined;
```

**The trigger is `agent_settled`, not `agent_end`.** `agent_settled` fires once per session-level run, after retries, compaction, and queued continuations. This is what deletes the defer rule. The `agent_end` and `agent_start` handlers are removed; the workspace and jj guards that lived in `agent_end` move to the settle handler.

**The session log is the transcript source.** The projection reads `getBranch()`, not `getEntries()` or `buildContextEntries()`. `getBranch()` keeps every ancestor, so a mid-Interaction compaction does not hide the pre-compaction messages. The projection extracts the message entries, calls the existing `deriveInteractionData`, and keeps the first and last message entry ids for provenance.

**The cursor is a Stamp marker.** After each Session stamp, the adapter writes a Stamp marker into the session log with the custom type `sillajje/stamp` and data `{ rev }`. The cursor is the marker's own entry id, read from the leaf after the write, because the append API returns nothing. A manual `/sillajje stamp -s @` also writes a Stamp marker, so it consumes the pending Interaction.

**The cursor is reconstructed from the branch.** On session start and on session tree navigation, the adapter scans the current branch for the last Stamp marker and sets the cursor to it. On a fresh session there is none, so the cursor is `null` and the whole branch is the slice. If the marker is absent from the branch, the cursor is `null`; re-stamping that branch's messages is acceptable for a fork.

**Session shutdown flushes.** If a completed Interaction is unstamped at shutdown, the adapter projects and stamps it before the existing unused-workspace archive runs.

**A failed stamp advances the cursor.** The adapter writes the Stamp marker whether the stamp succeeded, failed, or returned no-changes, matching today's "reset regardless" behaviour. The status sink already notifies on failure. The manual stamp is the recovery path. This avoids merging two Interactions' transcripts into one change.

**The core metadata builder gains one provenance field.** The stamp's `Meta:` section records `interaction: <first>..<last>`, the session entry range of the Interaction. The session key already scopes the range. The core stamp action's input shape is unchanged; the adapter still passes derived `InteractionData`.

**The state holder shrinks to session scope.** The interaction fields and their accessors are removed. What remains is the session lifecycle, the workspace path, the session key, the prompted flag, and the new cursor.

**The adapter handlers become thin routers.** `input` keeps only the archived-session guard and the prompted flag. `before_agent_start` keeps only the workspace system-prompt injection and the session bookmark creation. The prompt recording and the steering fallback are deleted, because the session log already has the prompt and pi never fires `before_agent_start` for a steering or follow-up delivery.

**The extension stays pi-only.** The projection stays in the extension. It is not moved to the core, because the entry shape is pi-specific and no second host exists.

**The pinned pi version is sufficient.** The change targets the pinned `^0.84.4`. It does not require `agent_before_settle` or `willRetry` on `agent_end`, which exist only on newer versions.

## Testing Decisions

A good test asserts external behaviour, not implementation. It must pass unchanged after a refactor that preserves behaviour. It never asserts an internal flag, a method call, or a private field. For the seam tests, the observable result is the jj change, the bookmark, and the session log, not the adapter's internals.

**The projection is tested at the new pure seam.** Unit tests over session-entry fixtures cover: a fresh session with a null cursor; one Interaction; a steering prompt folded in; a follow-up folded in; a retry with a mid-slice error message; a compaction entry inside the slice; a cursor that is not on the branch; a slice with no assistant message; and a slice with no user message. Prior art: the derive unit tests, which build pi-shaped message fixtures and assert a pure result.

**The adapter is tested at the existing extension-runner seam.** Integration tests drive the real event order against a real jj workspace: one change per run, including a run with a folded follow-up; reload reconstruction; session-tree reconstruction; shutdown flush; the `interaction:` line in the sealed body; and the archived and missing-workspace guards. The harness needs two additions: expose the session manager and add a helper that writes a user and an assistant message into the session log, because the adapter now reads the log instead of the `agent_end` payload. Prior art: the change-stamping integration suite.

**The metadata builder is tested at the existing core unit seam.** One case asserts the `interaction: <first>..<last>` line. Prior art: the core metadata tests.

**Tests that assert internals are deleted.** The state unit test's interaction cases assert flag transitions and are removed. The synthetic follow-up, steering, and deferral integration tests hand-sequence events and are replaced by the behaviour tests above.

## Out of Scope

- Giving each follow-up its own change by stamping at the final turn. Pi folds a follow-up into the run, and one change per run is the chosen model.
- Moving the projection into the core or supporting a non-pi host.
- Changing the core stamp action's input or the seal transaction.
- Preventing a duplicate change in the narrow crash window between the seal and the Stamp marker write.
- Changing cross-session stamping, Rev stamping, Sync, or Fold.
- Changing the manual stamp's user interface beyond consuming the pending Interaction.
- The `Loop:` section and the interaction-type taxonomy.

## Further Notes

- `agent_settled` was added for exactly this use and is documented as the signal for integrations that need to know pi will not continue automatically. The in-code comment claiming it does not reliably reach extension handlers is stale and should be corrected with the change.
- The narrow crash window: the seal is transactional, but the session log and jj are separate stores, so a crash between a successful seal and the Stamp marker write can produce a duplicate change on the next run. The marker is written after the seal. This is a known limitation, not a blocker.
- The `Meta:` provenance field is a small follow-up that touches the metadata schema. It can land after the lifecycle rework if the schema change is not wanted in the same step.
- The rework lands in staged steps: the projection module and its unit tests, then the adapter wiring with the old state deleted and the behaviour tests, then the metadata field. The glossary and ADR are already updated.
- The repo gate is green. Run the extension check after each step.
