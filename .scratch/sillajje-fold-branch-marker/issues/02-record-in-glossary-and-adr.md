# 02: Record the branch-keyed base in the glossary and ADR

**What to build:** the sillajje glossary's "Folded source" entry, the fold ADR, and the README fold section describe the branch-keyed marker (`sillajje/folded/<target>`), the ancestor rule, and the behavior of legacy markers.

**Blocked by:** 01 (the documents must describe landed behavior).

**Status:** resolved

- [x] The sillajje glossary's "Folded source" entry describes `sillajje/folded/<target>`, the ancestor rule, and that legacy markers are unread.
- [x] The fold ADR gains an amendment recording the branch key, the ancestor guard, no migration, and the one-time whole-fold.
- [x] The README fold section no longer describes the marker as keyed by the `--named` name relative to a source.

## Comments

Glossary "Folded source" rewritten, ADR 0006 amended ("the base is keyed by the review branch"), README fold section updated. `mise run check` exits 0.
