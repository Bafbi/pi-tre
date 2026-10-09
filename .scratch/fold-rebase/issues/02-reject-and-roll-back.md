# 02: Reject a bad `--rebase` revision and roll back a conflicting one

**What to build:** The failure behavior for `--rebase`. A revision that cannot be rebased onto the folded change is rejected before anything is generated or mutated. A revision that resolves to more than one or no commit is rejected. A rebase that produces file-level conflicts aborts the whole Fold, so nothing is half-published.

**Blocked by:** 01.

**Status:** done

- [x] A revision that is an ancestor of or equal to the target fails with a usage message before the sub-generator runs and before any mutation.
- [x] A revision that does not resolve to exactly one commit fails with a usage message.
- [x] A conflict on the rebased change aborts the whole transaction with the existing conflict result and file list, alongside a conflict on the folded change.
- [x] After a rejected or conflicted invocation, no folded change is published and no revision is moved.
- [x] The fold action's fake-port unit suite covers each guard and the conflict rollback.

**Deviation:** the resolution guard keeps a fixed usage message when the revset resolves to no or many commits. A jj read failure (an unknown revset, a broken repo) surfaces the cause as a fold failure instead.
