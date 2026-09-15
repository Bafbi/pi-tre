# 02: Publish clones atomically and classify aborted clones distinctly

**What to build:** A clone is fetched into a private temporary directory inside the tempspace and published at its clone target with a single atomic rename. Creating the target directory up front and deleting the target on failure are both removed. Cleanup only ever removes the caller's own temporary directory. It retries, so read-only pack files on Windows cannot make cleanup throw and mask the real error. A clone that is aborted or that times out is reported as aborted or timed out, not as a git failure. A real git failure still reports git's stderr. The result: two parallel calls for one repository both end with a usable clone, and a crash or cancel never leaves a partial target that a later call could reuse. When the publish rename loses the race because another caller published first, the caller re-probes the target and reuses it.

**Blocked by:** 01

**Status:** done

- [x] Two concurrent clones for one target both end with a usable clone; exactly one complete target exists afterward; no caller deletes another caller's data.
- [x] The loser of a publish race re-probes the target and returns a reused outcome.
- [x] A valid target published by another caller (a simulated second process) is reused.
- [x] A failed clone removes its temporary directory and leaves no target behind.
- [x] A killed or timed-out clone is reported as aborted or timed out, not as a git failure.
- [x] A real git failure still reports git's stderr, redacted.
- [x] A wrong branch name still returns git's branch suggestions on the failure path.
- [x] Repository identifiers that carry credentials stay redacted in every failure message.
- [x] Temporary cleanup succeeds when the clone left read-only files behind.
- [x] A test at the `ensureRepoCloned` seam covers this slice, driven by a fake `pi.exec` and a real temp filesystem (see PRD "Vertical slices").
- [x] The extension check passes.

## Notes

- The publish conflict with no valid target returns an `invalidTarget` failure; healing that target is ticket 04. Branch and default clone paths share one fetch-then-publish flow.
