# 01: Add `gitPush` to the jj boundary

**What to build:** The typed jj facade can push a bookmark to a named remote, or to jj's default remote when none is named. No caller builds the argv.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] `Jj.gitPush(input, options?)` is declared in `types.ts` and exported through the facade.
- [x] `gitPushArgv({ bookmark, remote? })` lives in `argv.ts` and returns `["git", "push", "-b", <bookmark>]`, with `["--remote", <remote>]` appended when a remote is named.
- [x] `createJj` implements `gitPush` via `queryString`, so a nonzero exit throws `JjError` with a `query` failure.
- [x] `argv.test.ts` covers with-remote and without-remote.
- [x] A facade test asserts the argv and the thrown `JjError`.
- [x] `mise run //packages/sillajje-jj:check` passes.

**Deviation:** Put the facade tests in a new `test/git-push.test.ts` rather than extending `workspace.test.ts`, since `gitPush` is not a workspace verb. The new required `Jj` method also forced a `gitPush` stub into `packages/sillajje-workspace/test/helpers.ts`.
