# 04: Harden `--rebase` coverage

**What to build:** Close the coverage gaps in the `--rebase` matrix. Reject an immutable revision before the sub-generator runs, and prove against real jj that a multi-commit subtree with a bookmark moves wholesale, that an ancestor of the target is rejected, that a revision already carrying the folded delta replays to empty commits without conflict, that a real rebase conflict rolls the whole Fold back, that a merge revision is rejected, and that `--update` and `--rebase` compose.

**Blocked by:** 01, 02.

**Status:** done

- [x] `--rebase <rev>` naming an immutable revision fails with a usage message before the sub-generator runs.
- [x] A revision whose descendants and bookmark move wholesale onto the folded change: the subtree moves and the bookmark follows.
- [x] `--rebase` naming an ancestor of the target is rejected before generation; `root()` is rejected too (as immutable).
- [x] `--rebase` naming a revision whose content the Fold already published succeeds and leaves empty commits. This is the accepted behavior, recorded, not a new guard.
- [x] A real rebase conflict rolls the whole Fold back with the conflicting files; nothing is published and no revision moves.
- [x] A merge revision is rejected before generation rather than reparented. jj's rebase replaces every parent with the destination, so moving a merge silently drops its other parents.
- [x] `fold … --update main --rebase @` advances `main` and moves the home revision in one command.
- [x] The fold action's fake-port unit suite covers the immutability guard and the merge guard.

**Deviation:** an earlier draft of this ticket asked for a merge revision to be reparented keeping its other parent. Real jj flattens a merge on rebase — `-s`, `-r`, and an unrelated destination all drop the other parents — so the merge rev is rejected with a usage message instead. A pre-generation immutability read (`<rev> & immutable()`) was added; an immutable non-ancestor rev now fails before the sub-generator, not after it.
