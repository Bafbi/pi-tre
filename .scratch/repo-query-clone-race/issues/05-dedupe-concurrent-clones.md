# 05: Dedupe concurrent clones and cancel only when the last caller aborts

**What to build:** Concurrent callers for one clone target share a single in-flight clone through a process-local registry keyed by the target. The registry entry is removed when the clone settles, so a later call retries after a failure. Callers for different targets are unaffected and remain parallel. A shared clone is cancelled only when every caller still interested in it has aborted. Aborting one caller stops only that caller from waiting. It does not discard a clone another caller needs.

**Blocked by:** 02, 03, 04

**Status:** done

**Follow-up:** Not part of the first cut. Land after tickets 02–04. The core already satisfies stories 1, 2, 4, and 6–16; this ticket adds stories 3, 5, 17, and 18.

- [x] Two concurrent callers for one target run exactly one clone; both outcomes are usable.
- [x] The registry key includes the requested origin, so a colliding repository cannot join an unrelated clone.
- [x] Callers for different targets still clone and explore in parallel.
- [x] A failed shared clone is retryable by a later call.
- [x] Aborting one caller does not cancel a clone another caller still needs.
- [x] Aborting every interested caller cancels the shared clone.
- [x] A test at the `ensureRepoCloned` seam covers this slice, driven by a fake `pi.exec` and a real temp filesystem (see PRD "Vertical slices").
- [x] The extension check passes.

## Notes

- Dedupe makes both in-process callers resolve the shared clone's `cloned` result, so the ticket-02 race test now asserts one clone and two usable outcomes; the simulated-second-process test still covers `reused`.
- The registry key is the clone target path plus the normalized requested origin. `runClone` checks the shared signal before publishing, so a clone aborted by its last interested caller never appears at the target. Aborted callers return before the shared clone finishes cleanup; tests wait for the cleanup.
