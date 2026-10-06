# 05: Fold Records

**What to build:** A Record for every Fold. The start Record carries the input flags; the terminal Record carries the resolved base, tip, and target, the subject, the folded rev, the change id, the marker and bookmark written, the remotes pushed, the diff manifest, and the Sub-generator fallbacks. A failed Fold carries the resolved refs it had, the failing status code, and jj's message, so the fallback subject and the exhausted generator of the originating incident are both visible.

**Blocked by:** 01 (the diff manifest), 02 (the Record type and write seam).

**Status:** done

- [x] A Fold writes a start Record with the input flags; the terminal Record carries the resolved base, tip, and target, on success and on failure.
- [x] A successful Fold records the subject, rev, change id, marker, bookmark, and pushed remotes.
- [x] The diff manifest is recorded, naming each omitted path and its reason.
- [x] A Fold that fell back records the header and summary fallback flags.
- [x] A failed Fold records the failing status code, jj's message, and the resolved refs when it had them.
- [x] No per-jj-command Records are written.
- [x] The tests read Records off the branch through the extension integration harness, and the diagnostics are asserted there.

## Notes

The core `FoldResult` gained a `diagnostics` field (base, tip, target, diff manifest, fallbacks), built during the fold and captured beside the existing result fields. The adapter's `fold` Record maps that to `resolved`, `diff`, and `generator`, with the marker, bookmark, pushed remotes, and archive flag in `result`. Failure maps `usage`, `conflict` (with files), and `failed` (with the captured error status, which carries the failing jj subcommand and stderr); the post-resolution failure branches also carry `resolved` from a `resolvedRef` captured once base and tip are known. The assertion was added to the existing first fold integration test rather than a new test, to reuse its jj and session setup.
