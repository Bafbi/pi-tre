# 03: Wire `--push` through the adapter and test it end to end

**What to build:** The `/sillajje:fold` command passes `--push` to the core action and names the pushed targets in its success notification. Integration tests drive real jj against a real bare remote.

**Blocked by:** 02.

**Status:** done

- [x] The adapter parses `--push` and passes `push` into `FoldInput`.
- [x] The success notification names the pushed targets when `pushed` is non-empty.
- [x] The integration harness can create a bare repo and add it as a remote.
- [x] `fold -r <rev> --update <bookmark> --push` moves `refs/heads/<bookmark>` on the bare remote.
- [x] `fold -r <rev> -o <target> --land --push` moves the landed bookmark on the bare remote.
- [x] An untracked bookmark gains a remote branch on `--push`.
- [x] A push to an unreachable remote warns and the folded child still exists.
- [x] `mise run //extensions/sillajje:check` passes.

**Deviation:** The integration run surfaced jj's reserved `git` remote (the local Git repository, tracked in a colocated repo but rejected by `jj git push --remote git`). `trackedRemotes` in `fold.ts` now filters it, with a matching unit case; the harness gained `addBareRemote` and `bareRef`. Triage: the push-before-archive ordering and the `pushed …` notification text now have assertions; for a session source the pushed commit id is not asserted, because the still-written session log makes jj rewrite the change after the push (only the change id is stable).
