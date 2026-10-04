# 01: Seed ignored paths into a new session Workspace

**What to build:** A project names ignored paths in a `seed` config list, and every new session Workspace copies those paths in from the checkout that launched the session, so the agent can read `.env`, `mise.local.toml`, or `.local/` from its first prompt. The Workspace records what it seeded — the source checkout root and a hash per path — so later commands can tell whether either side moved.

**Blocked by:** None (can start immediately).

**Status:** done

- [ ] The `seed` key is accepted in the global and project config layers, with an empty list as the default. The project layer is read only when the project is trusted. The committed `sillajje` config schema is regenerated.
- [ ] At Workspace creation, each listed workspace-relative path is copied from the launching checkout into the Workspace. A directory entry copies recursively.
- [ ] A destination path that already exists is not overwritten, so a tracked file and a previously seeded file both survive. A directory entry merges, and skips the existing files inside it individually.
- [ ] A listed path that does not exist in the checkout is a no-op and is reported to the user.
- [ ] A `sillajje/seed` entry is written to the session log, carrying the source checkout root and a SHA-256 hash per copied file.
- [ ] The copy runs only when the Workspace is newly created, never on a reused Workspace, so a reload or resume does not clobber the agent's edits.
- [ ] A seeded file stays invisible to jj: it never appears in `jj status` or in the session's `jj diff`.
- [ ] Tests cover the above at the extension integration seam.

## Comments

Built: the copy runs before `postInit`, so a post-init command can read a
seeded file. The Seed record is written only when at least one file was copied;
a list that copies nothing leaves none.
