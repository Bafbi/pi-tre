# @pi-tre/sillajje-workspace

Workspace lifecycle and session targeting over the typed `Jj` facade. It owns the workspace directory and its jj registration, and it answers which workspace a session owns. It knows the typed `Jj` facade, the session owner, and sillajje's session keys, and nothing of stamping or message generation.

## The port

`createWorkspaces(jj, options)` returns a `Workspaces` facade. It binds the `Jj` port and three values: `repoRoot`, `workspacesRoot`, and `owner` (`<user>/<host>`).

```ts
const workspaces = createWorkspaces(jj, {
  repoRoot,
  workspacesRoot: `${homedir()}/.pi/sillajje`,
  owner: defaultOwner(),
});
```

## Pure methods

`sessionKey(target)`, `ownerOf(key)`, `unqualified(key)`, `workspaceName(key)`, `bookmarkName(key)`, and `workspacePath(key)` are pure. The bookmark and workspace name are `sillajje/<session-key>`; the directory path is owner-free.

## Lifecycle

`ensure(sessionId)` creates or reuses a workspace, or reports `archived` when a surviving bookmark has no workspace. `lookup(key)` returns a registered root. `archive(key)` forgets the workspace and removes its directory, reporting `removed`, `already-gone`, or `failed`. `unarchive(key)` recreates the directory from the session bookmark.

## Session targeting

`resolveTarget(target, current)` returns the session's workspace path, or one of three negative reasons: `not-a-session` (no bookmark), `foreign` (another owner), `archived` (bookmark without a workspace). A target equal to the current session uses its stored path without a bookmark check.

## Boundary

This package imports no `@earendil-works/pi-*`. Every jj call goes through the typed `Jj` facade; the package builds no argv.
