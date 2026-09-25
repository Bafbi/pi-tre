# 04: Amend ADR 0006 with the push decision

**What to build:** Record in `extensions/sillajje/docs/adr/0006-fold-publishes-a-source-range.md` that the advanced review bookmark is pushed only on an explicit flag, to every tracking remote, best-effort, before archive.

**Blocked by:** 03.

**Status:** done

- [x] The amendment states the flag (`--push`), the targets (`--update` and `--land`), the per-tracking-remote rule, the untracked fallback, best-effort failure handling, and the push-before-archive order.
- [x] It records the rejected alternative: automatic push.
- [x] `mise run //extensions/sillajje:check` passes.

**Deviation:** Also records the reserved `git` remote filter and rejects the `fold.autoPush` config toggle.
