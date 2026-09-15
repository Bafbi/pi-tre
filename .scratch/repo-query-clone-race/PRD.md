# repo-query: clone concurrency and clone-target integrity

Status: ready-for-agent

## Problem statement

When the agent asks two `repo_query` questions about the same repository in one turn, both calls can fail with `Failed to clone <repo> (default branch).` The repository is reachable, and a single call for it succeeds. The user gets no usable answer, and the error text does not say what went wrong.

The failure is a race. pi runs the tool calls of one assistant message in parallel. Both calls compute the same clone target inside the shared session tempspace and run `git clone` into that one directory. One clone loses, and its failure cleanup deletes the directory the other clone is still using. Both calls then fail. The installed extension also discards git's stderr, so the only evidence is a generic message.

The same shared, in-place clone has quieter failure modes. A clone interrupted by a crash or a cancel leaves a half-written `.git` in place. The presence-only reuse test accepts it, so a later subagent explores a broken clone. A non-empty target left without a valid `.git` can make every later query for that repository fail forever. Recovery has no path. And because `dirName` is a sanitized name, two different repositories can map to one target. Today a failed origin lookup is reported as `reused`, which risks exploring the wrong repository.

None of this is a per-call bug. It is a missing invariant in the clone layer: nothing guarantees that what sits at a clone target is a complete clone, and nothing stops two callers from sharing one target unsafely.

## Solution

Make the clone layer guarantee that a clone target is either a complete clone or absent. Atomic publish makes concurrent callers safe without coordination: each clones into its own private directory, and the loser of the publish re-probes the target and reuses the winner's clone.

A clone is fetched into a private temporary directory and published at its target with a single atomic rename. Since a target only ever appears as the result of that rename, a half-written or cancelled clone can never be visible, and cleanup only ever removes the caller's own temporary directory, never a shared target. An existing target is trusted only after its repository is verified, so a broken or wrong clone can never reach a subagent.

A target left in a bad state produces an actionable error naming the path, and an empty leftover target is repaired automatically. Git's own error text is reported, and a cancelled or timed-out clone is reported as such rather than as a git failure.

The result, from the user's perspective: two questions about one repository get two answers, exploring several repositories stays parallel, and a broken clone never gets silently reused. Deduplicating the download itself is a follow-up, not part of this cut.

## User stories

1. As a Pi agent, I want to issue two `repo_query` calls for the same repository in one turn, so that I can investigate two questions about it at once.
2. As a Pi agent, I want both of those calls to return a usable answer, so that I do not have to serialize them or retry.
3. As a Pi agent, I want concurrent calls for the same repository to share one clone, so that I do not download the same repository twice. (Follow-up.)
4. As a Pi agent, I want concurrent calls for different repositories to clone and explore in parallel, so that exploring several repositories stays fast.
5. As a Pi agent, I want a clone already in progress to be reused by a later caller, so that duplicate work is avoided. (Follow-up.)
6. As a Pi agent, I want a failed clone to be retryable by a later call, so that a transient network error does not break the session.
7. As a Pi agent, I want a half-written clone never to be reused, so that my subagent does not explore a broken clone.
8. As a Pi agent, I want a cancelled clone to leave no usable-looking target behind, so that a later call starts from a clean state.
9. As a Pi agent, I want a crashed clone to leave only a temporary directory, so that the next call is unaffected.
10. As a Pi agent, I want a target that holds a different repository to be reported as a collision, so that I do not explore the wrong repository.
11. As a Pi agent, I want a target left in a bad state to produce an actionable error naming the path, so that I can tell the user what to do.
12. As a Pi agent, I want an empty leftover target to be healed automatically, so that a platform quirk does not block the query.
13. As a Pi agent, I want a real git error (bad branch, auth, network) reported with git's own message, so that I can act on it.
14. As a Pi agent, I want a clone that times out to be reported as timed out, not as a git failure, so that I understand the cause.
15. As a Pi agent, I want a clone that is aborted to be reported as aborted, so that cancellation is distinguishable from failure.
16. As a user, I want to cancel a slow clone, so that I do not wait for a repository I no longer need.
17. As a user, I want cancelling one call not to discard a clone another call still needs, so that my other questions are still answered. (Follow-up.)
18. As a user, I want cancelling every call for a repository to stop its clone, so that I do not waste network and time. (Follow-up.)
19. As a user, I want the error to name the failing repository clearly, so that I know which one to retry.
20. As a user, I want repository identifiers that carry credentials to stay redacted in errors, so that secrets do not leak into the transcript.
21. As a user, I want branch suggestions when a branch name is wrong, so that I can fix the identifier.
22. As a user, I want a query for a repository already cloned this session to reuse it, so that repeated questions stay cheap.
23. As a maintainer, I want the meaning of a clone target written in the glossary, so that future changes use one vocabulary.
24. As a maintainer, I want the concurrency decision recorded in an ADR, so that a future reader understands why clones are published atomically.
25. As a maintainer, I want the clone layer's invariants covered by tests at a single seam, so that refactors cannot silently break them.
26. As a maintainer, I want the tempspace still reused per session, so that repeated queries stay cheap.
27. As a maintainer, I want sessions that recorded the old details key to still reuse their tempspace, so that upgrading does not duplicate clones.
28. As a maintainer, I want one name per concept in the code and the glossary, so that code and domain language match.
29. As a maintainer on Windows, I want temporary cleanup to survive read-only pack files, so that failed clones neither leak nor mask the real error.
30. As a maintainer, I want the publish step to be cross-process safe, so that two Pi processes sharing a session directory cannot corrupt a target.
31. As a maintainer, I want the extension's error text to include git's stderr, so that diagnosis does not require reading the source.

## Implementation decisions

**Vocabulary (to be captured in a glossary).** *Tempspace*: the per-session temporary root that holds clones. *Clone target*: the directory inside the tempspace that one repository identifier resolves to. It is the unit of reuse and concurrency. *Publish*: the atomic rename that makes a finished clone visible at its target.

**Modules modified.** The clone layer, the tempspace layer, and the tool result types. Documentation is added alongside.

**Atomic publish.** A clone is fetched into a unique private directory inside the tempspace and published to its target with a single `rename`. The previous step that created the target directory up front is removed, as is every code path that removes the target. The reason is the invariant below: on this platform a rename onto a missing destination or an empty directory succeeds, and onto a non-empty directory fails, which is what makes the loser of a publish race detectable by re-checking the target rather than by trying to interpret a platform-specific error code.

**Invariant.** A clone target is complete or absent. It is only ever created or replaced by the atomic rename. Failure cleanup removes only the caller's own temporary directory.

**Target verification.** Before an existing target is reused, its repository is verified with `git rev-parse -q --verify HEAD`. Only a repository whose HEAD resolves counts as present. This supersedes the current presence-only `.git` check. When HEAD resolves but the origin cannot be read, the target counts as present and is reused. Only a readable origin that differs from the requested one is reported as a collision.

**Invalid-target recovery.** When the publish rename conflicts and no valid target is present, the layer attempts to remove the target only if it is empty (`rmdir`), then retries the publish once. If the target is non-empty and invalid, the call fails with a message that names the path and states that it must be removed. The clone layer never force-replaces a non-empty target.

**Scope of this cut.** The core lands first: atomic publish, target verification, invalid-target recovery, killed-first result classification, and error reporting. Process-local dedupe and its shared-abort refcounting are a follow-up. They save duplicate downloads, not correctness.

**Follow-up: dedupe on demand.** Concurrent callers for the same clone target share a single in-flight clone through a process-local registry keyed by the absolute clone target path. The registry entry is removed when the clone settles, so a later call retries after a failure. Callers for different targets are unaffected and remain parallel. This runs in-process only. The atomic publish carries cross-process safety. The key must also carry the requested origin, or the origin check must run once per caller after the shared clone resolves. A key of path alone would let a caller for a colliding repository join an unrelated clone and skip the collision check.

**Follow-up: abort semantics.** A shared clone is cancelled only when every caller still interested in it has aborted. An individual caller aborting stops that caller waiting but does not discard a clone another caller needs. When the last interested caller aborts, the shared clone is cancelled.

**Result classification.** A clone outcome distinguishes: cloned, reused, and failed with a reason of `clone` (git), `collision`, `invalidTarget`, `aborted`, or `timeout`. Aborted and timed-out outcomes are detected from the cancel signal and from the exec result's `killed` flag, rather than being fed into the git-failure branch.

**Error reporting.** git's stderr tail is included in the failure message and redacted as today. This is the part already present in the working tree and missing from the installed package.

**Cleanup robustness.** Temporary directories are removed with recursive and force semantics plus retries, so read-only pack files written by a failed clone do not make cleanup throw and mask the original error.

**Renames.** The tempspace concept is renamed to match the glossary in code and types. The persisted details field is renamed to the tempspace spelling, and reads of session history accept both the old and new key so that existing sessions still reuse their tempspace.

**Documentation.** A `CONTEXT.md` glossary for the extension is added with the three terms above, an ADR records the atomic-publish decision, the invariant, the cross-process guarantee (one `rename`, no locks), and the deferred dedupe, and the root context map is added listing the extension contexts and noting that "workspace" is the jj extension's term while "tempspace" is this extension's.

**Prototype-derived shape (from the diagnosis).** The clone outcome and registry entry decisions are encoded most precisely as:

```
CloneResult =
	| { status: "cloned" }
	| { status: "reused" }
	| { status: "failed"; reason: "clone" | "collision" | "invalidTarget" | "aborted" | "timeout"; error: string }

// Follow-up: Registry: Map<absoluteCloneTargetPath, Promise<CloneResult>>
```

## Testing decisions

A good test here observes external behavior only. Given a tempspace, a repository identifier, a cancel signal, and a scripted git process, what does the clone layer return, and what exists on disk afterward. Tests assert on the returned outcome and on the presence, completeness, and origin of the clone target. They never assert on private helpers and never recompute the expected value the way the implementation does. Expected outcomes come from the domain rules (complete-or-absent, coalesce, collision), not from the code under test.

**Seams under test.**

- Primary, existing: `ensureRepoCloned(repo, tempspace, signal, pi)`, driven with a fake `pi.exec` and a real temporary filesystem. This is the highest seam at which the clone algorithm is observable with control. All changed behavior lives below it, and two concurrent calls at this seam exercise the race directly. Prior art: `test/unit/clone.test.ts`.
- Secondary, existing: `getTempspacePath(ctx)`, used only for the backward-compatible read of the old details key. Prior art: `test/unit/workspace.test.ts`.

No new seams are introduced. The tool-level wiring is unchanged and remains covered by the existing integration test that clones a real repository and asserts sequential reuse.

**Vertical slices, smallest first.** Each slice is one failing test, then the minimal implementation to pass it.

1. Coalesce: two concurrent calls for one target, a barrier-held clone, assert both outcomes are usable, exactly one complete target exists, and no caller deleted the other's data.
2. Collision: concurrent calls whose clones report different origins for one target, assert the loser gets the collision reason and the winner's target is unchanged.
3. Invalid target: a target holding a `.git` without a resolvable HEAD must not be reported as present.
4. Abort and timeout: a killed clone with no exit code is classified as `timeout` or `aborted`, not as a git failure.
5. Recovery: a non-empty invalid target fails with an actionable message, and an empty target is healed and published.

**Determinism.** A barrier-controlled fake git process drives concurrency. The filesystem is real and temporary. No network is used. The existing real-GitHub test remains the only service test and is unchanged.

## Out of scope

- Batch pre-clone at the assistant-message boundary. The seam exists, but it blocks the turn and still requires the per-call fallback. Dedupe on demand delivers the same outcome more cheaply.
- Serializing tool calls by declaring the tool sequential.
- Cross-process locking or in-flight dedupe across processes. The atomic publish is the cross-process guarantee.
- Automatic sweeping or garbage collection of stale temporary directories.
- A rename retry to absorb transient Windows AV interference.
- Changes to subagent tooling, model resolution, output truncation, or GitHub validation.
- Migrating or deleting partial targets left by older sessions beyond the documented recovery path.

## Further notes

- The extension installed via pi's package setting is a stale checkout and does not contain the stderr reporting present in the working tree. The fix must be verified against the working tree. The maintainer installs the refreshed extension and runs the acceptance tests.
- This spec is the durable output of a longer diagnosis. The working notes, reproduction commands, second-opinion triage, and platform probes are collected in a local report under the same feature directory.
- The Windows empty-directory case is why recovery heals an empty target but refuses to force-replace a non-empty one. The rename error code itself is not a reliable signal across platforms.
