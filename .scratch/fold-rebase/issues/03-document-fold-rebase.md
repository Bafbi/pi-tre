# 03: Document `--rebase` in the Fold glossary and ADR 0006

**What to build:** The Fold glossary entry describes `--rebase`, and ADR 0006 gains an amendment recording the repo-root resolution, the in-transaction atomicity, and the conflict abort. No new glossary term is introduced; the home revision stays the user's vocabulary.

**Blocked by:** 01, 02.

**Status:** done

- [x] The Fold glossary entry describes `--rebase` and introduces no new term.
- [x] ADR 0006's amendment records that the revision resolves at the repo root, that the move runs inside the Fold transaction, and that a conflict aborts the whole Fold.
- [x] The amendment notes the relationship to `Sync` and leaves the glossary's existing warning against "rebase" as the `Sync` subcommand name in place.

**Deviation:** none. The glossary entry covers repo-root resolution and the in-transaction conflict abort.
