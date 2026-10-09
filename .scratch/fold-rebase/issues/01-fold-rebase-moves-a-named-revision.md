# 01: Fold `--rebase` moves a named revision onto the published change

**What to build:** `fold … --rebase <rev>` publishes the Fold, then moves the named revision and its descendants onto the folded change, with the caller's working copy following. The revision resolves in the caller's checkout, so `@` is the home working-copy revision even when the Fold source is a session in another workspace. The move runs inside the Fold's one transaction. The success notification names the rebased revision, and the caller's working copy is left current. `--rebase` composes with every existing flag.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] `fold … --rebase <rev>` moves the named revision and its descendants under the folded change; the Fold source branch is unchanged.
- [x] With a session source, `--rebase @` moves the caller's home working-copy revision, never the session workspace's working copy.
- [x] The caller's working copy reflects the move after the command; a failed working-copy update warns and does not undo the Fold.
- [x] The published body, the `Ref:` line, and the Folded source marker are unchanged by `--rebase`.
- [x] `--rebase` composes with `--named`, `--update`, `--push`, `--archive`, and `--exclude`; no new mutual exclusion. `--no-marker` does not interact with the rebase.
- [x] The success notification and the debug record name the rebased revision; the help text documents the flag; a bare `--rebase` with no value is a parse error.
- [x] The args parser unit suite covers the flag; the fold action's fake-port unit suite asserts the rebase mutation targets the folded change and the result carries the rebased revision; the fold integration suite moves a home revision onto the folded change against real jj.

**Deviation:** none. The result field is `rebase` as specified. The working-copy refresh runs only when `--rebase` is given. `--no-marker` is not separately tested against `--rebase`: it skips the marker store and the rebase runs after it, so it has no path into the move.
