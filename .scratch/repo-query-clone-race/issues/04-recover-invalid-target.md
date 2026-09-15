# 04: Recover or report an invalid target

**What to build:** When publishing a clone conflicts with a target that is not a valid clone, the extension heals it if it is empty and reports it if it is not. An empty leftover target is removed and the publish retried once. A non-empty invalid target fails with a message that names the path and states that it must be removed. A non-empty target is never force-replaced, so a valid clone published by another caller can never be discarded.

**Blocked by:** 03

**Status:** done

- [x] An empty leftover target is healed and the clone is published there.
- [x] A non-empty target that is not a valid clone fails with a message naming the path.
- [x] The failure is clear and retryable once the user removes the named path.
- [x] No code path deletes a non-empty target.
- [x] A test at the `ensureRepoCloned` seam covers this slice, driven by a fake `pi.exec` and a real temp filesystem (see PRD "Vertical slices").
- [x] The extension check passes.

## Notes

The empty-target `rmdir` + retry is only distinguishable on platforms where `rename` rejects an empty destination (Windows). On Linux the atomic rename onto an empty directory already succeeds, so the test covers the published outcome. The invalid-target message now says the path "must be removed before retrying".
