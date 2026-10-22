# Fold publish gate

Type: grilling
Status: resolved
Blocked by: —

## Question

What does the publish-triggered gate do when a check fails during a Fold?

Settled going in: publish is the second gate. An interaction is cheap to redo; a publish is not, so the full set runs before work leaves the workspace. A red gate never loses work, but a Fold is a publish act, not a save act, so the rule there may differ from the stamp rule.

Open sub-questions:

- **Which tree.** A Fold publishes `tree(tip) − tree(base)`. Does the gate check the folded change (the child of the target), the source tip, or the session workspace as it stands? The folded change is what the reviewer sees; the source is what was tested at settle time.
- **Where it aborts.** Before the deferred transaction opens, or inside it so a red check abandons the transaction? The transaction already rolls back on a conflict; rolling back on a red check is consistent but runs jj work that gets thrown away.
- **The override.** Does a red gate block the Fold outright, or warn and proceed? Is there a `--no-verify`-shaped flag on the colon command surface (`/sillajje:fold --no-verify`)? What does it do to the marker?
- **Non-workspace sources.** A Fold of a rev source (`-o <rev>` with no session) and a Fold of an archived session have no live workspace to run in. Skip the gate, or run it in a temp workspace? Skipping silently is a hole; a temp workspace is expensive.
- **The body.** Does the Fold body record the check outcome, the way it records `Ref:` and `Skipped:`? `actions.fold.body` currently offers `summary`, `ref`, `skipped`.
- **The Outcome.** What the user sees on a blocked Fold, and whether the failing check's output reaches them.

## Answer

Decided with the user.

**Red blocks the Fold. `--no-check` overrides it, and the override is recorded.**

- A publish-triggered check runs once, before the deferred transaction opens. A red result emits an error status, returns a failed `FoldResult`, and the fold publishes nothing.
- `--no-check` proceeds anyway. It is recorded — in the fold's `Checks:` section (ticket 04) and in the Fold's Record — so `jj show` and the session log both say the publish went out unverified. An override that leaves no trace would make the gate decorative.
- `--no-check` is a no-op when no publish-triggered check exists. It never errors on a repo that declares none.

**The checked tree is the source workspace's working copy, before the transaction opens.** The settle gate already checked every interaction; the publish checks cover what settle skipped, and the source working copy is exactly that content. Accepted gap: a check that depends on the *target's* tree is not caught, because the folded change is `tree(tip) − tree(base)` placed onto the target and only exists inside the transaction. Building it first and undoing it on red would defeat the transaction.

**No live workspace means no publish run, and the Fold refuses.** A rev source and an archived session have nothing to run in. Creating a temp workspace for the rare path costs a workspace lifecycle for a validation the common path already gets, so the answer is a flag instead: the fold fails with an error naming the check and telling the user to pass `--no-check`. A missing workspace (deleted by hand) is the same state and takes the same rule. The refusal only fires when a publish-triggered check actually exists; a repo that declares none folds a rev source as it does today.

**Mechanism decisions, with why.**

- One run, no continuation. A Fold's caller is the user, not an agent loop, so there is nothing to hand a report back to mid-run. The 5-attempt budget from [Feedback to the agent](02-feedback-to-the-agent.md) is an interaction policy and does not apply.
- The override flag is `--no-check`, carried on `FoldInput` next to `noMarker` (`fold.ts:92`), matching the existing `--no-<thing>` shape. It is spelled on the usage line at `fold.ts:1165` and documented in the fold help block.
- The check's `cwd` is the source workspace path, so it inherits the `postInit` dependencies and the exact environment the agent worked in.
- A red gate folds nothing, so no Folded source marker is written and the cursor does not advance. A `--no-check` fold writes its marker as usual, because the publish did happen.
- `--push` after `--no-check` publishes an unverified revision. That is the user's explicit choice; the `Checks:` section is what carries the warning to the reviewer.
- The outcome reaches `jj show` through ticket 04's `Checks:` section, not a fold-specific section.

**Rejected.** A temp workspace at the source revision (a workspace lifecycle for a rare path), and skipping silently (a publish gate that quietly does nothing is worse than a refusal).
