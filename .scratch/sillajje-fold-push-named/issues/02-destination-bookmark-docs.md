# 02: Record the destination-bookmark term in the docs

**What to build:** the docs name the bookmark `--push` publishes the **destination bookmark** — the review bookmark `--named` sets, or the landing bookmark `--update` advances. `CONTEXT.md` gains the term and its Fold entry is reworded, and ADR 0006's `--push` amendment is retitled and loses the "`--push` with neither is a usage error" sentence, which the new behavior replaces.

**Blocked by:** 01 (the ADR describes landed behavior)

**Status:** done

- [x] `CONTEXT.md` defines **destination bookmark** and uses it in the Fold entry instead of "the advanced bookmark".
- [x] ADR 0006's "`--push` publishes the advanced bookmark" section is retitled to the destination bookmark and covers both `--named` and `--update`.
- [x] The "`--push` with neither is a usage error" sentence is gone, replaced by the rule that `--push` requires one of the two destination flags.
- [x] No doc explains `--named` and `--update` with separate push wording.

**Deviation:** also updated the "Rejected: pushing automatically" paragraph from the old `--land` name to `--named`/`--update`; left the `--land` references in the earlier `--exclude` and `--no-marker` amendments, which the ADR's own convention keeps as old-name references.
