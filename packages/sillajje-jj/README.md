# @pi-tre/sillajje-jj

The typed boundary to the `jj` process. It owns every jj command, the deferred-operation transaction, and the parsing of jj output. It knows jj and nothing of sillajje sessions, stamps, or folds.

## The port

`createJj(exec)` returns a `Jj` facade. `exec` is an `ExecFn` — the same shape as pi's `exec`, `(command, args, options) => Promise<ExecResult>`. `ExecFn` is internal to the package; callers receive `Jj` and name typed operations.

```ts
const jj = createJj((command, args, options) => pi.exec(command, args, options));
```

Every `Jj` method takes an optional trailing `ExecOptions` (`cwd`, `signal`, `timeout`).

## Reads

`log(revset)` returns `Commit[]`. `diff(revset)` returns the diff text. `conflicts(revset?)` returns conflicted paths. `bookmarks()` returns `Bookmark[]`. `workspaces()` returns `Workspace[]`. `version()` and `checkVersion()` read the jj version.

Reads throw a `JjError` on failure. A decode failure names the field and the raw line.

## Writes

`apply(mutation)` runs one `Mutation` and returns `Result<MutationResult>`. A `Mutation` is data; the package builds the command line. The vocabulary is `describe`, `new`, `bookmarkSet`, `duplicate`, `squash`, and `rebase`.

`transaction(recipe)` runs a group of `Mutation`s all-or-nothing. Each step is a deferred operation chained on the previous; one `jj op integrate` publishes the group. A failed step abandons the operations the chain minted and returns a typed `JjFailure`. The `Tx` handle exposes `apply` and a `conflicts` read at the transaction's current deferred op.

## Workspace verbs

`workspaceAdd`, `workspaceForget`, and `workspaceUpdateStale` wrap the workspace lifecycle commands.

## Boundary

This package imports no `@earendil-works/pi-*`. `packages/sillajje-core/test/import-boundary.test.ts` fails on a violation.
