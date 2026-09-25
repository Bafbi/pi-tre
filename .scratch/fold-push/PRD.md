# Fold push: publish the advanced review bookmark

Status: ready-for-agent

## Problem Statement

`fold --update <bookmark>` and `fold --land` advance a local bookmark inside the deferred transaction. If that bookmark is tracked by a remote, the local bookmark and the remote diverge: `jj bookmark list` then shows `review @origin (behind by N commits)`. Nothing in `FoldResult` or the status stream says the remote is stale, and the user must remember to run `jj git push` after every update. A review branch that has been pushed therefore silently stops tracking the work until someone pushes by hand.

## Solution

Add `--push` to `fold`. After a successful fold, the action pushes each bookmark the fold advanced — the `--update` target and/or the single `--land` bookmark — to every remote that tracks it. A bookmark with no tracking remote is pushed once without `--remote`, which creates the remote branch and starts tracking it. Push runs after the transaction commits and before `--archive`, because archiving a session workspace removes the directory `jj` runs in.

Push is best-effort. A failed push is reported as a warning on the status sink and leaves the fold successful; the fold change is already committed and does not roll back. `--push` is explicit, matching `--land` and `--archive`; the repo does not push automatically.

## User Stories

1. As an agent user, I want `fold --update review --push` to advance `review` and update `origin/review` in one command, so that a pushed review branch keeps up with the fold.
2. As an agent user, I want `fold --land --push` to push the landed bookmark, so that publishing to trunk and updating its remote are one step.
3. As an agent user, I want a bookmark tracked by several remotes pushed to each of them, so that no published copy goes stale.
4. As an agent user, I want a never-pushed bookmark to get a remote branch on `--push`, so that the first fold can publish without a separate push.
5. As an agent user, I want a failed push to warn me and leave the fold in place, so that a network or auth failure does not hide the work that was folded.
6. As an agent user, I want `--push` with neither `--update` nor `--land` rejected, so that I do not pass a flag that does nothing.
7. As a maintainer, I want the push to run before `--archive`, so that pushing from a session workspace does not race its removal.
8. As a maintainer, I want the jj boundary to own the push command line, so that no caller builds `jj git push` argv.
9. As a maintainer, I want the fold action's push targets derived from the same bookmarks the transaction advanced, so that the local and remote branches cannot disagree about which bookmark moved.
10. As a maintainer, I want an ADR note recording the flagged, best-effort push, so that the next reader does not propose automatic pushing.

## Implementation Decisions

**The jj boundary gains a `gitPush` method, not a Mutation.** Push is not part of the deferred transaction: the transaction runs every step with `--at-op <base> --ignore-working-copy --no-integrate-operation`, which cannot carry a network command and must roll back atomically. Follow the `workspaceAdd` / `workspaceForget` pattern instead: a dedicated `Jj` method that builds argv in `argv.ts` and runs it directly.

```ts
gitPush(
  input: { bookmark: string; remote?: string },
  options?: ExecOptions,
): Promise<void>;
```

`gitPushArgv` returns `["git", "push", "-b", bookmark]`, appending `["--remote", remote]` when a remote is named. The facade runs it through `queryString`, so a failure throws `JjError` carrying a `query` failure; the caller catches and warns.

**Push targets are the bookmarks the fold advanced.** `--update` advances `reviewBookmarkFor(folded)`, which is the `targetRev`. `--land` advances `ontoBookmark`. After the transaction, the action pushes `targetRev` when in update mode and `ontoBookmark` when it is set. `--push` with neither is a usage error checked before any mutation.

**A tracked bookmark is pushed to every tracking remote.** `jj.git push` does not derive the remote from tracking: the help states "the remote to push to is not derived from the tracked remote bookmarks… There is no option to push to multiple remotes." So the action reads `jj.bookmarks()` once, collects the `remote` values of the entries whose `name` equals the bookmark, and runs one push per remote. When no entry tracks the bookmark, it pushes once with no `remote`, and jj creates and tracks the branch. Marker bookmarks (`sillajje/folded/…`) and session bookmarks are never push targets.

**Push failures are warnings, not fold failures.** Each `gitPush` call is wrapped; a caught error emits `{ kind: "warning", code: "push_failed", message }` naming `bookmark` or `bookmark@remote`. The remaining pushes still run. `FoldResult.ok` gains `pushed?: readonly string[]`, the successfully pushed targets, so the adapter can name them.

**Push runs before archive.** The order after a successful transaction is push, then archive. Archiving removes the session workspace defensively; the push reads bookmarks and runs jj in `sourceCwd`.

## Testing Decisions

A good test observes the pushed remote, not the internal push loop. It asserts through the `Jj` `gitPush` calls at the core seam and through the real remote at the integration seam.

**The jj boundary is tested at its existing argv and facade seams.** `argv.test.ts` asserts `gitPushArgv` with and without a remote. A facade test with a fake `ExecFn` asserts the argv and that a nonzero exit throws `JjError`. Prior art: the `workspaceAdd` / `workspaceForget` tests.

**The fold action is tested at the existing core unit seam.** Extend `fold.test.ts`'s fake `Jj` with `gitPush` and `bookmarks` fixtures. Cases: `--update --push` pushes to each tracking remote; a bookmark with no tracking remote pushes once without `remote`; a failing push warns and still returns `ok: true`; `--push` without `--update` or `--land` is a usage error before the transaction; `--land --push` pushes the landed bookmark. Prior art: the `--update` and `--land` cases.

**The adapter is tested at the existing integration seam against a real bare remote.** `fold.test.ts` gets a helper that makes a bare repo and adds it as a remote. Cases: `fold --update review --push` moves `refs/heads/review` on the bare remote; `--land --push` moves it; an untracked bookmark creates the remote branch; a push to an unreachable remote warns and the fold child still exists. Prior art: the fold integration suite and its `jj` helpers.

## Out of Scope

- Pushing automatically without `--push`. `--land` and `--archive` are opt-in; push is too.
- Pushing the folded source, the `sillajje/folded/…` marker, or any session bookmark.
- A read-only "the remote is behind" notice for folds without `--push`. The tracking count is jj's own `ahead`/`behind` line, needs ancestry, and is a separate follow-up.
- `--force` / `--force-with-lease`. The fold appends, so a plain push fast-forwards; jj's own safety check rejects a remote that moved ahead.
- A config toggle such as `fold.autoPush`. The flag is the explicit override.
- Pushing tags or `--all`.

## Further Notes

- jj 0.44: `jj git push -b <name>` fast-forwards a tracked, appended bookmark without `--force`; verified against a bare remote.
- The default remote when `remote` is omitted is `git.push`, else `origin`. An untracked bookmark pushed this way is auto-tracked by jj.
- The push loop reads bookmarks once after the transaction. A remote added between the read and the push is not seen; acceptable.
