# 02: Add `--push` to the fold action

**What to build:** After a successful `fold --update <bookmark>` or `fold --land`, `--push` pushes the advanced bookmark to every remote that tracks it, or to jj's default remote when none does. A failed push warns and leaves the fold successful. `--push` with neither `--update` nor `--land` is a usage error.

**Blocked by:** 01.

**Status:** done

- [x] `FoldInput.push?: boolean` and `FOLD_ARGS` / `FOLD_HELP` accept `--push`.
- [x] `--push` without `--update` or `--land` returns a `usage` result before any mutation.
- [x] After the transaction, the action pushes the `--update` target and/or the `--land` bookmark.
- [x] A bookmark tracked by several remotes is pushed once per remote; an untracked bookmark is pushed once with no remote.
- [x] Marker and session bookmarks are never pushed.
- [x] A failed push emits `{ kind: "warning", code: "push_failed" }` and the fold still returns `ok: true`.
- [x] `FoldResult.ok.pushed` lists the successfully pushed targets as `bookmark` or `bookmark@remote`.
- [x] Push runs before `--archive`.
- [x] Unit tests in `fold.test.ts` cover each case above.
- [x] `mise run //packages/sillajje-core:check` passes.

**Deviation:** Added a `pushing` phase status; the guard is an action check rather than an `exclusive` pair, since `--push` composes with `--update` or `--land`; a failed `bookmarks()` list warns and skips push instead of falling back to the default remote. Triage: `--update` and `--land` are exclusive, so the fold advances at most one bookmark; the action now models that as a single `advancedBookmark` rather than a `targets` list, so a duplicate push cannot arise. The push loop lives in `pushAdvancedBookmark`, and `FoldResult.ok.pushed` is always present (empty when `--push` did not run).
