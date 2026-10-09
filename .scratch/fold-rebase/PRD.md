# Fold `--rebase`

Status: done

## Problem Statement

Landing work with a Fold publishes the delta as one change under the target, but it leaves the caller's own history where it was. A developer who keeps a long-lived home revision on top of `trunk()`, with the working copy set to it, ends up with a home revision sitting beside the newly landed change instead of on top of it. They then move it by hand with `jj rebase`, repeating the target rev and the folded change id that the Fold already computed. The hand move is easy to forget and easy to point at the wrong rev.

## Solution

`fold` gains a `--rebase <rev>` flag. After the Fold publishes its change, the named revision is moved — with its descendants — onto the published change, and the caller's working copy follows it. The rev is resolved in the caller's checkout, so `@` means the home revision, not the Fold source's workspace. The move happens inside the Fold's one transaction: a rebase that conflicts rolls the whole Fold back, and a Fold never rebases anything on its own.

## User Stories

1. As a developer keeping a home revision on top of `trunk()`, I want `fold --rebase @` to move my home revision onto the published change, so that my working copy continues from the work I just landed.
2. As a developer, I want `--rebase` to take an arbitrary revision, so that I can stack any branch on the published change, not only the working copy.
3. As a developer, I want `--rebase` to move the named revision together with its descendants, so that a chain of work moves as a unit.
4. As a developer, I want `--rebase @` to mean my home working-copy revision even when the Fold source is another session's workspace, so that I never accidentally move the source workspace's working copy.
5. As a developer, I want the rev to resolve at the repo root, so that the flag means the same thing regardless of which workspace the command runs in.
6. As a developer, I want to compose `--rebase` with `--update`, so that the landing form `--update main --rebase @` advances the target and moves my home revision in one command.
7. As a developer, I want `--rebase` to compose with `--named`, so that I can name a review branch and restack onto it in one command.
8. As a developer, I want `--rebase` to compose with `--push`, so that the advanced bookmark is pushed and my home revision still moves.
9. As a developer, I want `--rebase` to compose with `--archive`, so that a session source can be retired and my home revision still moves.
10. As a developer, I want `--rebase` to compose with `--exclude` and `--no-marker`, so that the flag is independent of what the Fold publishes and records.
11. As a developer, I want a rebase that conflicts to roll the whole Fold back, so that I never end up with a published change and a half-moved home revision.
12. As a developer, I want the conflicted files reported, so that I can resolve them and decide whether to Fold again.
13. As a developer, I want the caller's working copy updated to the rebased revision, so that I do not see a stale working copy after the command.
14. As a developer, I want a failed working-copy update to warn but not undo the successful Fold, so that a rare jj hiccup does not discard generated work.
15. As a developer, I want `--rebase` naming an ancestor of the target to be rejected before message generation, so that a cyclic rebase fails fast and spends no sub-generator call.
16. As a developer, I want `--rebase` naming a revset that does not resolve to exactly one revision to be rejected, so that the flag has one clear meaning.
17. As a developer, I want `--rebase` to require a value, so that the command states which revision moves.
18. As a developer, I want the success notification to name the rebased revision, so that I can see the home revision moved without running `jj log`.
19. As a developer, I want the Fold's published body, `Ref:` line, and Folded source marker to be unchanged by `--rebase`, so that a rebase never leaks into provenance.
20. As a developer, I want the Fold source branch to survive a `--rebase`, so that nothing about publishing is made destructive.
21. As a developer, I want `--rebase` to run when the source is a session, a rev, or the current session, so that the flag works with every Fold source.
22. As a developer, I want `--rebase` to leave the target bookmark alone unless `--update` is also given, so that the two flags stay independent.
23. As a developer, I want the fold to never rebase unless I ask, so that an ordinary Fold stays a pure publish.
24. As an agent, I want the flag documented in the help text, so that I can discover it from the command.
25. As an agent, I want the repo-root resolution and the atomic rollback recorded in the Fold glossary and an ADR amendment, so that I do not reinterpret what `@` means later.

## Implementation Decisions

- The Fold action input gains an optional `rebase` string naming one revision.
- The shared command spec gains a `--rebase` flag: takes a required value, not repeatable. The usage line and help text gain the flag and a one-line description.
- The revision resolves at the repo root — the directory the folded command already treats as its working directory — before the transaction opens. The resolution is a normal jj read, so it snapshots the caller's working copy first. The resolved change id is passed into the transaction. This makes `@` the caller's home working copy, never the Fold source's workspace working copy, when the source is a session.
- A cycle guard rejects, before message generation, a revision that is an ancestor of or equal to the target: rebasing such a revision onto the folded change (a child of the target) cannot succeed.
- A resolution guard rejects a revision that does not resolve to exactly one commit.
- An immutability guard rejects an immutable revision, and a merge guard rejects a merge revision, both before message generation. jj will not rewrite an immutable commit, and a jj rebase replaces a merge's parents with the destination.
- The transaction recipe gains one step, after the marker, the named bookmark, and the `--update` bookmark: a rebase of the resolved change id onto the folded change.
- Conflict detection extends to the rebased change id. A conflict on either the folded change or the rebased change throws the existing conflict abort, so the whole Fold rolls back with the conflict reason and the file list.
- After the transaction integrates, the action runs `workspace update-stale` at the repo root, mirroring Sync. A failure emits an `update_stale_failed` warning and leaves the Fold successful.
- The result gains an optional `rebase` field carrying the value the user typed. The adapter renders it as a `(rebased <rev>)` note beside the existing named and pushed notes, and the debug event records it.
- Compose with every existing flag. No new mutual exclusion. `--rebase` and `--update` stay independent.
- `--rebase` with no value is a parse error, because the flag takes a required value.
- The flag is opt-in per invocation. There is no config key and no automatic rebase.
- The rebase uses the boundary's existing `rebase` mutation, which lowers to `jj rebase -s <source> -o <onto>`. The jj boundary is unchanged.
- The Folded source marker, the `Ref:` provenance line, and the published Commit body are unchanged. The rebase is not published content and is not recorded.
- The Fold glossary entry in the extension's `CONTEXT.md` describes `--rebase`, and ADR 0006 gains an amendment recording the repo-root resolution, the in-transaction atomicity, and the conflict abort. No new glossary term is introduced; the home revision stays the user's vocabulary.

## Testing Decisions

- Good tests assert external behavior only: the action's returned result, the mutations the transaction applies, the emitted status stream, the parser's output, and the end-to-end jj state after the registered command runs. Private helpers are not tested directly.
- Fold action unit suite, with fake ports and a recording sink: assert the recipe applies a rebase mutation with the resolved change id and the folded change as the destination; assert a rebase that conflicts returns the conflict result and no successful fold; assert the cycle guard and the single-revision guard return usage failures; assert the result carries the rebased revision. The fake jj gains the working-copy update verb so the post-transaction step is observable.
- Args parser unit suite: assert `--rebase @` parses to the rebase value, and that a bare `--rebase` is an error.
- Fold integration suite, against real jj through the registered command: a home working-copy revision on top of `trunk()` is moved onto the folded change and the home working copy is not stale; the success notification carries the rebased revision. Use the existing helpers that drive the command and read the resulting graph.
- Prior art: the existing fake-port fold suite (result, statuses, and transaction recipe assertions) and the existing real-jj fold integration suite (children of the target, file lists, notifications). All new tests are hermetic.

## Out of Scope

- A home-revision concept in sillajje. The flag moves whatever revision it is given.
- Rebase selectors other than "the revision and its descendants". Branch-relative and revisions-only selectors, and insert-before/insert-after placement, are not surfaced.
- Skipping or dropping commits that become empty because the Fold already published their content.
- More than one `--rebase` value per invocation.
- A bare `--rebase` that defaults to `@`.
- Rebasing without the flag.
- Updating stale working copies other than the repo root, and moving bookmarks that a rebase did not target.
- Changes to `--push`, `--archive`, `--update`, `--named`, `--exclude`, or `--no-marker` behavior.
- A configuration toggle for the flag.
- Any change to the Fold transaction mechanism.

## Further Notes

- The landing form the flag is designed for: `fold -s @ -o main --update --rebase @`.
- The cycle guard sits before the sub-generator on purpose: a rejected invocation must not spend an LLM call.
- `--rebase` differs from `Sync` in both direction and purpose. Sync brings a target into a session's ancestry as a merge and keeps the session active. `--rebase` moves a named revision onto the Fold's published change. The glossary's warning against "rebase" as the `Sync` subcommand name is untouched.
- ADR 0006 (fold publishes a source range onto a target) is the ADR amended, because the repo-root resolution is a real, hard-to-reverse choice about what `@` means.
- The Fold action lives in the core composition package; the adapter that parses the flag and renders the outcome lives in the extension. The seam split is unchanged.
