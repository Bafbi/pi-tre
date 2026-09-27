# 01: Key the `--update` base to the review branch, with an ancestor guard

**What to build:** `fold --update <bookmark>` appends only new work no matter which source published the previous fold, including a session handed off with `/sillajje:new -s @`. The folded-source marker becomes `sillajje/folded/<target>` in the read and both write paths. The read accepts the recorded tip as the base only when it is an ancestor of the current tip; a missing marker or a non-ancestor tip falls back to `fork_point(tip | target)` with the existing `fold_update_fallback` info. The now-dead source-name resolution is removed.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] `--update <bookmark>` resolves its base from `sillajje/folded/<bookmark>` and duplicates `recorded..tip`.
- [x] A source whose tip descends from the recorded tip appends only its new work — the `/sillajje:new -s @` handoff case — verified against a real jj repository.
- [x] `-o <rev> --named <branch>` seeds `sillajje/folded/<branch>`, and a later `--update <branch>` from a different source reads it.
- [x] A missing marker, or a recorded tip that is not an ancestor of the current tip, bases on `fork_point(tip | target)` and emits the `fold_update_fallback` info.
- [x] The marker name carries no source or session half; the source-name resolution and the fold source's `name` field are removed.
- [x] A legacy `sillajje/folded/<source>/<target>` marker is not read and triggers the fallback.
- [x] The fold unit and integration suites pass with branch-only marker assertions, with new cases for the handoff append and the non-ancestor fallback.

## Comments

Implemented in `packages/sillajje-core/src/fold.ts`. The marker key is `sillajje/folded/<target>` on the read and both write paths. `--update` uses the recorded tip only when it is an ancestor of the current tip, and otherwise falls back to the fork point with `fold_update_fallback`. `FoldSource.name` and `foldedSourceName` are removed.

Covered by the core unit suite (branch key, non-ancestor, legacy key) and the fold integration suite (renamed source, two-session handoff). `mise run check` exits 0.
