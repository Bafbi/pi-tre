# 02: Fold and sync progress

**What to build:** `/sillajje:fold` accumulates two steps — `folding` with its target revision or review bookmark, then `pushing` with the advanced bookmark. `/sillajje:sync` shows one step, `rebasing`, with its target revision. A conflicting fold freezes the failed step with a cross and keeps the widget until the next command.

**Blocked by:** 01 — Progress tracer — archive and unarchive

**Status:** done

- [x] Core `fold` emits `folding` with the target revision (`--onto`) or the review bookmark (`--update`).
- [x] Core `fold --push` emits `pushing` with the advanced bookmark.
- [x] Core `sync` emits `rebasing` with the target revision.
- [x] The adapter supplies the phrases for the fold and sync codes.
- [x] Integration covers the two-step accumulation for a fold and the frozen step after a conflicting fold.
- [x] Integration covers the single rebase step for a sync.

## Notes

- Deviation: a conflict emits a `warning`, not an `error`, so the renderer gained `Progress.fail()` and the fold and sync handlers call it on a `failed` or `conflict` result. Freezing only on `error` would have missed every conflict.
- The `folding` target is the raw target rev (`targetRev`), which is the review bookmark in `--update` mode.
