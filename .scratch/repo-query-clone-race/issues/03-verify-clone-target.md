# 03: Verify a clone target before reusing it

**What to build:** An existing clone target is reused only when its repository has a resolvable HEAD. A target whose repository is incomplete, unborn, or absent is not treated as present, and a target holding a different origin is reported as a collision naming both origins instead of being explored. Local clones that legitimately have no origin still count as present.

**Blocked by:** 02

**Status:** done

- [x] A target whose repository has no resolvable HEAD is not reported as reused.
- [x] A target holding a different origin yields a collision failure naming both the requested and existing origins.
- [x] A HEAD-valid target whose origin cannot be read, including a local clone with no origin, is reused rather than reported as a collision.
- [x] A half-written target can never reach the subagent.
- [x] A test at the `ensureRepoCloned` seam covers this slice, driven by a fake `pi.exec` and a real temp filesystem (see PRD "Vertical slices").
- [x] The extension check passes.

## Notes

- Presence is now `git rev-parse -q --verify HEAD` in both the up-front reuse check and the publish-conflict re-probe. Existing single-call mocks dispatch on `args`, since each clone now also probes HEAD.
