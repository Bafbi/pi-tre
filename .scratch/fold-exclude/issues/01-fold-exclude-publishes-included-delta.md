# 01: `fold --exclude` leaves named paths out of the published delta

**Spec:** `.scratch/fold-exclude/PRD.md`

**What to build:** Running a Fold with `--exclude <path>` publishes a change that carries the session's work without the named paths. The flag is repeatable and works in both modes, `-o <rev>` publish and `--update <bookmark>`. The excluded paths stay in the source and in the session log, so a handoff session still inherits them. The Folded source marker keeps recording the source tip, so the excluded paths never publish from that review branch.

**Blocked by:** None (can start immediately).

**Status:** done

Note: the `abandon` step is emitted only when a fileset is present, so the no-exclude recipe is byte-for-byte the old one; the ticket read as if it were unconditional.

- [ ] `fold` accepts `--exclude <path>` in both `-o` publish and `--update` modes, repeatable, and reports a missing value as a usage error.
- [ ] The fold help text documents `--exclude`.
- [ ] Two or more `--exclude` values are all honoured; each value is a workspace-relative path prefix or glob, so both `.scratch/` and `*.lock` work.
- [ ] The folded change's tree lacks the excluded paths; the source revision and the session log keep them.
- [ ] The Folded source marker still records the source tip, and a following `--update` does not publish the excluded paths.
- [ ] The generated Summary describes only the included paths.
- [ ] A delta whose included diff is empty returns `no-changes` before any mutation, the same no-op as an empty delta.
- [ ] A conflicting Fold rolls back completely: no folded change, no duplicated copies left behind, and no bookmark moved.
- [ ] As a prefactor, the shared parser supports a repeatable flag; a repeated non-repeatable flag keeps its last-wins behavior and every existing command is unchanged.
- [ ] The jj boundary accepts filesets on `squash` and applies the new `abandon` mutation inside the deferred transaction.
- [ ] The transaction recipe keeps duplicating the whole delta, because `jj duplicate` takes no fileset, and becomes: new an empty child of the target, duplicate the delta onto the target, squash the copies into the folded change with the included fileset, abandon the duplicated range, then the existing conflict check and bookmark writes. The prototype against `jj 0.44.0` showed that a partial squash does not empty the copies, so the abandon step is what removes the excluded paths.
- [ ] `--exclude` combines with `--land`, `--named`, `--push`, and `--archive`.
- [ ] A real-jj integration test drives the registered command and shows an excluded directory absent from the folded change's tree while the source keeps it, and a fold whose delta only touched excluded paths returning `no-changes`.

## Done

- The parser collects repeated values for a repeatable flag; non-repeatable flags keep last-wins.
- `squash` carries filesets; a new `abandon` mutation goes through the deferred transaction; `diffRange` takes a fileset.
- The Fold compiles `--exclude` into one included fileset, filters the squash and the diff with it, and abandons the copies a partial squash leaves behind.
- `--exclude` is repeatable on `fold` in both modes and appears in the help.
- Real-jj integration tests cover the exclusion and the all-excluded `no-changes`.
