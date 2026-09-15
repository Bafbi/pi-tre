# Publish clones atomically

A clone is fetched into a private temporary directory inside the tempspace and published at its clone target with a single `rename`. The target is created or replaced by nothing else. That gives the clone layer one invariant without coordination: a clone target is either a complete clone or absent.

## Invariant

A clone target is complete or absent. It is only ever created or replaced by the atomic publish. Failure cleanup removes only the caller's own temporary directory, never a clone target. Before an existing target is reused, its repository is verified with `git rev-parse -q --verify HEAD`, so a half-written, unborn, or wrong clone never reaches a subagent. A non-empty target that is not a valid clone is never force-replaced; the call fails naming the path, and an empty leftover target is removed and the publish retried once.

## Considered Options

**Path A (chosen): atomic publish with one `rename`, no locks.** Cross-process safe because a rename onto a missing destination or an empty directory succeeds, and onto a non-empty directory fails. The loser of a publish race re-probes the target and reuses the winner's clone. Concurrent Pi processes sharing a session directory cannot corrupt a target, and the extension holds no lock.

**Path B (rejected): batch pre-clone at the assistant-message boundary.** Clone every repository once before the turn's tool calls run. Rejected because it blocks the turn and still needs the per-call fallback for repositories discovered later.

**Path C (rejected): declare the tool sequential.** Run one `repo_query` at a time. Rejected because it serializes different repositories too, losing the parallelism that keeps exploring several repositories fast.

**Follow-up: in-process dedupe.** Concurrent callers in one process share a single in-flight clone through a registry keyed by clone target plus requested origin. The entry is removed when the clone settles, so a later call retries after a failure. A shared clone is cancelled only when every caller still interested has aborted. This was deferred from the first cut and landed after it; cross-process safety still comes from the atomic publish, not the registry.

## Consequences

- A crashed or cancelled clone leaves only a temporary directory, never a partial clone target.
- An empty leftover target is healed automatically; a non-empty invalid target must be removed by hand.
- `session_shutdown` removes the tempspace. Stale temporary directories are not swept automatically.
