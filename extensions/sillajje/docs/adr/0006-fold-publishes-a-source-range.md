# Fold publishes a source range onto a target

`fold` aggregates the diff of a source range (`base..tip`) into one clean change whose parent is the target, and it **appends**: each fold adds a change, so a pull-request branch grows without a force-push. The commit body is a generated subject and summary plus `Ref: <base>..<tip>` — no `Meta:`, no `Loop:`. The source branch survives, and each fold records the folded source tip in a `sillajje/folded/<name>` bookmark, so the next fold publishes only the delta.

## Considered Options

**Range replay via `jj duplicate` then `jj squash` (chosen)** vs copying the source tip's tree vs merging source and target directly vs consuming the source with `jj squash --from`. A real-jj prototype showed the tip copy and the direct merge both conflict whenever a fix edits code the already-folded commits introduced — the ordinary "debug the code I just wrote" case. Consuming the source empties the working branch. Duplicating the delta and squashing the copies is clean, non-destructive, and runs inside the deferred transaction.

**Recorded base (chosen)** vs deriving the base from the graph. `merge-base` is wrong after the first fold, and a whole-range replay onto the aggregation conflicts on the already-folded changes. The delta base cannot be derived; it must be recorded or supplied.

## Consequences

- The first fold uses `merge-base(source, target)`; later folds read `sillajje/folded/<name>`.
- `--land` moves the target bookmark inside the transaction; `--archive` is session-source-only; both are opt-in, and fold is never automatic.
- `--exclude` is deferred: it interacts with the base assumption, and the prototype did not exercise it.
- Contradicts ADR 0004's "fold is the designated future consumer of `stampRev`"; that sentence is amended there.

## Amendment: publish and update are separate modes

`-o <rev>` publishes: it bases on `fork_point(source, target)` and writes the whole source delta as one change under the target. `--update <bookmark>` updates: it bases on the recorded folded-source tip and appends only the new work onto that bookmark, advancing it. `--update` is exclusive with `-o`, `--land`, and `--named`, and falls back to the fork point (with an info status) when no marker exists. `--named [<branch>]` names the folded change with a bookmark — `fold-<change id>` when empty — and keys the marker by that name; without `--named` the marker keys on the target's single local bookmark.

The marker is `sillajje/folded/<source>/<target>`, so one source can feed several review branches.

A session source folds from its last seal: the tip is the `sillajje/<session>` bookmark (the last stamped change), never the workspace working copy. After a stamp the workspace `@` is a fresh empty child, and the next interaction stamps it, so taking `@` as the base or the recorded tip would swallow the next stamp's work.

This supersedes the first consequence above ("later folds read `sillajje/folded/<name>`") and the default in the "Recorded base" choice. The recorded base remains, but only as the explicit `--update` path.

Markers written before this amendment use `sillajje/folded/<name>`. The new key does not read them, so the first `--update` after upgrade finds no record, falls back to the fork point, and whole-folds once.

## Amendment: `--push` publishes the advanced bookmark

`fold --update <bookmark> --push` and `fold --land --push` push the bookmark the transaction advanced after it commits. `--update` and `--land` are exclusive, so the fold advances at most one bookmark: the `--update` target or the `--land` bookmark. `--push` with neither is a usage error. The flag is opt-in like `--land` and `--archive`; fold never pushes on its own.

The action reads the bookmark list once and pushes to every remote that tracks the advanced bookmark, one `jj git push -b <name> --remote <remote>` per remote. jj does not derive the push remote from tracking and has no multi-remote push, so naming each remote explicitly is the only way to keep several published copies current. A bookmark with no tracking remote is pushed once without `--remote`, which creates the remote branch and starts tracking it. The reserved `git` remote — the local Git repository, tracked in a colocated repo — is filtered out, because `jj git push --remote git` is rejected. Marker and session bookmarks are never pushed.

Push is best-effort. The fold is already committed, so a failed push emits a `push_failed` warning and leaves the fold successful; the remaining remotes still get their push. Push runs before `--archive`, which removes the session workspace.

A session source folds its session log, and the log keeps being written. jj can therefore rewrite the folded change after the push, leaving the remote on the same change id but an earlier commit id until the next push. This is inherent to folding a tracked session log, not to the push, so it is accepted.

**Rejected: pushing automatically.** Push is a non-rollbackable external side effect on a shared branch. The repo requires an explicit override for risky behavior, and `--land` and `--archive` are already explicit; an automatic push would violate that. Also rejected: a `fold.autoPush` config toggle, which hides the side effect behind config instead of a flag.

## Amendment: the base is keyed by the review branch

The folded-source marker is `sillajje/folded/<target>`. The base a Fold records belongs to the review branch, not to the source that published it. `<target>` is the fold name (`--named`), `--update`'s bookmark, or the target's single local bookmark. `--update` reads the record for its bookmark whatever the source, so a source that continues another source's history — a session handed off with `/sillajje:new -s @`, a renamed rev, or a source that advanced — appends only its new work.

**Branch key (chosen)** vs `sillajje/folded/<source>/<target>`. The source half only separates independent sources that share one review branch, a case that is not supported. It breaks the handoff case, where the new session key misses the record and re-aggregates from the fork point, and it leaves one marker per session per branch. This supersedes the marker key asserted in the first amendment above ("The marker is `sillajje/folded/<source>/<target>`").

`--update` uses the recorded commit only when the marker resolves to exactly one commit and that commit is an ancestor of the current tip. Otherwise — a missing marker, a conflicted or rewritten bookmark, an unrelated source, or a rewrite the marker did not follow — it falls back to `fork_point(source, target)` with the `fold_update_fallback` info. The marker stays a jj bookmark, so a single-successor source rewrite carries it to the new commit.

Markers written before this amendment use `sillajje/folded/<source>/<target>`. The branch key does not read them, so the first `--update` after upgrade finds no record, falls back to the fork point, and whole-folds once. Legacy markers are left in place; there is no migration or cleanup.

## Amendment: `--exclude` leaves paths out of the published change

`fold` accepts a repeatable `--exclude <path>` in both modes. Each value is a path or a glob, and the action compiles the values into one jj fileset and publishes the delta of everything else. The excluded paths stay in the source, and the session log keeps carrying them, because a session handoff (`/sillajje:new -s @`) continues from the previous session's seal. They are never published from that review branch: the Folded source marker still records the source tip, and `--update` reads that tip as its next base, so a later fold does not pick them up. The generated Summary and the empty-delta check use the included fileset, so the body never describes a path the change does not carry, and a delta whose included diff is empty returns `no-changes`. A Fold that excludes every changed path is that no-op: it renders no `Skipped:` line and emits no exclusion status, because `no-changes` is the report. The fold body gains a `Skipped:` line listing the excluded paths, so `actions.fold.body` defaults to `["summary","ref","skipped"]`.

This supersedes the first section's "`--exclude` is deferred" consequence. The prototype now exercises it: `jj duplicate` takes no fileset, so the whole delta is still duplicated; the squash that folds the copies into the folded change carries the included fileset; and the copies a partial squash leaves non-empty are abandoned explicitly, where an unfiltered squash abandons them implicitly by emptying them.

**Exclusion (chosen)** vs three alternatives. Adding `.scratch/` to `.gitignore` drops the tickets from the session log too, and the handoff carries that log, so the tickets must stay tracked. Deferred exclusion — folding the excluded paths on a later fold — needs the marker to name an included tree instead of a source tip, which needs an extra materialized commit and a shape a bookmark cannot hold. Cosmetic exclusion, leaving paths out of the Summary but not the tree, changes nothing a reviewer acts on.

**`--exclude <path>`, repeatable (chosen)** vs a general `--fileset <fileset>`. A fileset flag is one flag for both directions, but it makes the caller spell jj's language, and the shared parser splits on whitespace, so it cannot carry a fileset with operators. The path flag compiles internally to a complemented `prefix-glob` fileset, `~(prefix-glob:"<path>")`, with `"` and `\` escaped. The value is matched as jj's `prefix-glob`, so `**/*.lock` excludes lock files at any depth and `*.lock` only at the workspace root. `FlagDef` gains a `repeatable` field, because the parser keeps only the last value of a repeated flag.

**Permanent, in both modes, per invocation (chosen)** vs sticky on the review branch. A bookmark cannot hold a path list, so a sticky exclusion needs a new place to live. The flag stays opt-in like `--land`, `--push`, and `--archive`, and fold never excludes on its own.

**`Skipped:` in the body (chosen)** vs a status event only. The drop is permanent and leaves no other trace on the branch, so `jj show` must show it. An info status still reports the exclusion at fold time.
