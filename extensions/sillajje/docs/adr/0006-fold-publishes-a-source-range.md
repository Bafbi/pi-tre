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

`-o <rev>` publishes: it bases on `fork_point(source, target)` and writes the whole source delta as one change under the target. `--update <bookmark>` updates: it bases on the recorded folded-source tip and appends only the new work onto that bookmark, advancing it. `--update` is exclusive with `-o`, `--land`, and `--name`, and falls back to the fork point (with an info status) when no marker exists. `--name [<branch>]` names the folded change with a bookmark — `fold-<change id>` when empty — and keys the marker by that name; without `--name` the marker keys on the target's single local bookmark.

The marker is `sillajje/folded/<source>/<target>`, so one source can feed several review branches.

A session source folds from its last seal: the tip is the `sillajje/<session>` bookmark (the last stamped change), never the workspace working copy. After a stamp the workspace `@` is a fresh empty child, and the next interaction stamps it, so taking `@` as the base or the recorded tip would swallow the next stamp's work.

This supersedes the first consequence above ("later folds read `sillajje/folded/<name>`") and the default in the "Recorded base" choice. The recorded base remains, but only as the explicit `--update` path.

Markers written before this amendment use `sillajje/folded/<name>`. The new key does not read them, so the first `--update` after upgrade finds no record, falls back to the fork point, and whole-folds once.
