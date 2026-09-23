# Forget is the authority; the directory is bytes

**Status**: accepted

jj keeps a workspace registered until `jj workspace forget` runs. Deleting the
directory does not unregister it: `jj workspace list` still shows the workspace
with a blank root, and `jj workspace add` with that name fails. The workspace
package therefore treats the registration, not the directory, as the source of
truth. Archive always forgets, even when the directory is already absent, and
create forgets the intended name immediately before `workspace add`.

## Considered Options

- **Directory-first (the obvious path).** Treat a missing directory as "archived"
  and skip forget when the directory is gone. Rejected: it leaks a phantom
  registration that blocks the name and shows up in `jj workspace list` forever.
- **Registration-first (chosen).** Always forget and tolerate any directory
  state. `jj workspace forget` on an unknown workspace warns and exits 0, so the
  call is safe to repeat.

## Consequences

- A directory jj does not register is never trusted and never deleted. It may
  belong to a different repository that shares the repo slug. Create takes the
  next free suffix instead.
- The archive result distinguishes *removed* from *already gone*. Both are
  success, but a user should be able to tell which happened.
