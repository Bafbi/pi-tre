# Fold `--push` publishes the destination bookmark

Status: ready-for-agent
Type: spec

## Problem Statement

A user who folds with `--named` gets a review bookmark for the folded change, but
cannot publish it. `--push` is accepted only beside `--update`, and it pushes the
landing bookmark `--update` advances. To get a named review branch onto its
remotes, the user folds, then pushes the branch in a second step outside
sillajje. The two flags that name a Fold's destination (`--named`, `--update`)
differ in whether their bookmark can be pushed, for no reason the user can see.

## Solution

`fold --named <branch> --push` publishes the review bookmark the Fold names, to
the remotes that track it. `--update --push` keeps its current behavior: it
publishes the landing bookmark the Fold advances. The two flags stay mutually
exclusive, so a Fold has exactly one destination bookmark and `--push` never has
to guess. A bare `--push` with neither flag stays a usage error.

The published bookmark is the Fold's **destination bookmark**: the review
bookmark `--named` sets, or the bookmark `--update` advances. The glossary gains
the term, so help, the Fold entry, and ADR 0006 all name the same thing.

## User Stories

1. As a session author, I want to fold my work onto a target while naming a
   review branch and pushing it in one command, so a reviewer can fetch the
   branch without a second step from me.
2. As a reviewer, I want the named review bookmark to already exist on the remote
   after the author folds with `--push`, so I can review as soon as the author
   says it is ready.
3. As a session author, I want `--push` beside `--named` to publish the review
   bookmark `--named` sets, so the pushed ref is the branch the flag just named.
4. As a session author, I want `--push` beside `--update` to keep publishing the
   landing bookmark, so my existing workflow does not change.
5. As a user, I want a bare `--push` with neither `--named` nor `--update` to
   stay a usage error, so a typo never pushes nothing in silence.
6. As a user, I want the usage error to name both `--named` and `--update`, so I
   know which flag to add.
7. As a user who writes `--named` with no value, I want `--push` to publish the
   generated `fold-<change id>` bookmark, so the combination has no hidden
   special case.
8. As a user, I want `--push` to stay opt-in, so fold never pushes on its own.
9. As a user, I want a failed push to warn and leave the fold successful, so a
   remote problem never discards committed work.
10. As a user, I want one push per remote that tracks the destination bookmark,
    so several published copies stay current.
11. As a user, I want a destination bookmark with no tracking remote to be pushed
    once to the default remote, so a new review branch appears without setup.
12. As a user, I want the Outcome to report each pushed target as `bookmark` or
    `bookmark@remote`, so I can confirm what was published.
13. As a user, I want `--push` beside `--named` to still record the Folded source
    marker, so the next fold from that source stays incremental.
14. As a user, I want `--push` to run before `--archive`, so the session
    workspace is removed only after the branch is published.
15. As a user folding a rev source, I want `--named --push` to work the same as
    for a session source, so the publish path does not depend on the source kind.
16. As a user, I want `--no-marker` to leave `--push` alone, so the marker and
    the push stay independent decisions.
17. As a user, I want a destination name I chose in the `sillajje/` namespace to
    push like any other, so the "never pushed" rule stays limited to the implicit
    Folded source marker and the session bookmark.
18. As a user, I want `--named` and `--update` to stay mutually exclusive, so
    there is never ambiguity about which destination `--push` publishes.
19. As a maintainer, I want the pushed targets carried in the existing `pushed`
    result field, so the Outcome and the Record need no new shape.
20. As a maintainer, I want one term, destination bookmark, across help, the
    glossary, and ADR 0006, so the docs do not explain `--named` and `--update`
    separately.

## Implementation Decisions

- **Module**: the Fold Action in `@pi-tre/sillajje-core`. No other package
  changes; the extension adapter already renders `result.pushed`.
- **Push target**: generalize the Action's internal push target to the Fold's
  destination bookmark. `--named` resolves it to the review bookmark; `--update`
  resolves it to the advanced bookmark, as today. The empty-`--named` case
  resolves to `fold-<change id>` after the fold, when the change id exists.
- **Guard**: replace the `--push requires --update` check with one that accepts
  either `--named` or `--update` and rejects neither. Keep the message naming
  both flags.
- **Push mechanics**: reuse the existing best-effort publisher unchanged — read
  the bookmark list once, push to every tracking remote, push once with no
  `--remote` when untracked, filter the reserved `git` remote, warn and continue
  on failure, and never make the push a second fold.
- **Result contract**: the `pushed` field keeps its shape (`bookmark` or
  `bookmark@remote`). No schema or config change.
- **Docs**: update `FOLD_ARGS.usage` and the `FOLD_HELP` `--push` line; add
  **destination bookmark** to `CONTEXT.md` and reword the Fold entry; amend
  ADR 0006's "`--push` publishes the advanced bookmark" section to "publishes the
  destination bookmark" and drop the "`--push` with neither is a usage error"
  sentence, which this spec replaces.

## Testing Decisions

A good test asserts external behavior: the Action's result, the status stream it
emits, and the jj mutations it asks for. It does not assert private helpers or
the order of internal calls beyond what the behavior requires.

- **Primary seam (one)**: the Fold Action built over fake jj ports, the existing
  `createFold` seam. It covers the guard, the selected push target for each flag,
  the status events, and the failure path. Prior art:
  `packages/sillajje-core/test/fold.test.ts` — `--push pushes the landed bookmark
  to every tracking remote`, `--push uses jj's default remote for an untracked
  bookmark`, `a failed push warns and leaves the fold successful`, and `rejects
  --push without --update` (to be reworded).
- **Flag spec (secondary, existing)**: `FOLD_ARGS` parse and help text, in
  `packages/sillajje-core/test/args.test.ts`. Prior art: the `FOLD_ARGS` block
  there.
- **End-to-end (existing)**: `extensions/sillajje/test/integration/fold.test.ts`
  runs the command against a real jj repo and a bare remote. Prior art:
  `--push on an appended review branch advances the remote` and `--update --push
  advances the landed bookmark on the remote`, with `addBareRemote`, `bareRef`,
  and the notification assertions.

New cases: `--named <review> --push` publishes the review bookmark; `--named ""`
`--push` publishes `fold-<change id>`; the reworded bare-`--push` error; and the
end-to-end path where a named review branch appears on the bare remote.

## Out of Scope

- Pushing an implicit Folded source marker (`slj/f/...`) or a session bookmark.
- A config toggle for automatic push; fold stays explicit per invocation.
- Pushing with neither `--named` nor `--update`.
- Changing how `--update` selects or advances its bookmark.
- Changing the push transport: still `jj git push`, one remote at a time.

## Further Notes

ADR 0006's `--push` amendment is the prior decision this spec extends. It
asserted "`--push` with neither is a usage error" and named only the advanced
bookmark; both sentences change. The destination-bookmark term also matches the
`<dest>` slot in the Folded source marker `slj/f/<dest>/<source>`, so the marker
key and the pushed ref now share one name.
