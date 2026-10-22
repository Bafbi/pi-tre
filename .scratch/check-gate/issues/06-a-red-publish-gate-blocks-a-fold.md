# 06: A red publish gate blocks a fold

**What to build:** Before a Fold publishes anything, the publish-triggered checks run once against the source workspace. A red check publishes nothing and says why. A user who knows the failure is environmental overrides it with a flag, and the published change says it went out unverified.

**Blocked by:** 02.

**Status:** done

- [x] Publish-triggered checks run once, before the Fold's transaction opens, against the source session workspace's working copy. The publish gate never loops.
- [x] A red check returns a failed Fold result. Nothing is published, no Folded source marker is advanced, and the reason names the failing check.
- [x] `--no-check` overrides the publish gate, and the override is recorded in the fold's `Checks:` line and in the Record.
- [x] A source with no live workspace — a revision source, an archived session, a missing workspace — refuses the Fold when a publish check exists, and the refusal names the flag. A repo that declares no publish check folds such a source exactly as it does today.
- [x] The Fold's Commit body carries the `Checks:` section after `Ref`, selectable through the existing body-order config and present in the published JSON schema.
- [x] `--no-check` on a repo with no publish check is a no-op, not an error.
- [x] Tests: green publish, red publish, `--no-check`, no-workspace refusal, and a repo with no publish check, through the integration harness against real jj.

**Deviation:** `--no-check` renders as `waived (--no-check)`; the publish gate passes the diff paths to the path filter.
