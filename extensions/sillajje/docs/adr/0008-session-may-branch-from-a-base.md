# A new session may branch from a base other than `trunk()`

`/sillajje:new` starts a session whose workspace branches from a named Base — a revision (`-o <rev>`) or another session's bookmark (`-s <id>`) — instead of `trunk()`. This relaxes ADR 0001's rule that every workspace starts from the trunk: unlanded session work can seed a new session, which is the point (continue a line of work in a fresh context). `trunk()` stays the default, so the isolation guarantee holds for every session that does not name a base.

## Considered Options

**Record the Base in the new session's log (chosen)** vs a module-level handoff vs a pending file vs an environment variable. `ctx.newSession` rebinds extensions, so `session_start` runs in a fresh instance with fresh state. The command writes the Base as a custom entry in `ctx.newSession`'s `setup`, which runs before `session_start`; the new instance reads the entry back. The entry is also durable, so a reload finds the workspace already created and never re-bases it.

**A separate `/sillajje:new` command (chosen)** vs extending pi's `/new`. Pi gives extensions no way to add flags to a built-in command. A command registered as `new` collides with the built-in and is skipped in autocomplete, so `/new` cannot be extended in place.

## Consequences

- ADR 0001's "clean slate per session" holds only for a session with no named Base.
- `-o @` captures the current workspace's working copy, so unsealed work can seed the new session; `-s @` takes the last seal (the session bookmark), never the workspace `@`.
- The base is resolved to a commit id when the workspace is created, so moving the source bookmark later does not move the new session.
- `-s` accepts an archived session (the bookmark is all the Base needs) and rejects a foreign one (the owner rule keeps other owners' sessions out of this repo's work).
