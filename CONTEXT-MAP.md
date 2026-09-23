# Context Map

`pi-tre` is a monorepo of Pi extensions. Each extension is its own context, with its own glossary where one is resolved.

## Contexts

- [leaf-copy](./extensions/leaf-copy): copies editor text or the last leaf message to the clipboard
- [repo-query](./extensions/repo-query/CONTEXT.md): clones git repositories into a per-session tempspace and answers questions with a subagent
- [sillajje](./extensions/sillajje/CONTEXT.md): auto-versioning for Pi sessions built on jj
- [stale-write-guard](./extensions/stale-write-guard/README.md): blocks `edit` and `write` after a stale read

### Sillajje package contexts

The sillajje extension is split into three packages. Each owns its own context.

- [sillajje-core](./packages/sillajje-core/CONTEXT.md): the composition layer — Actions, the shared status event, and the config schema.
- [sillajje-jj](./packages/sillajje-jj/CONTEXT.md): the typed substrate over the `jj` process.
- [sillajje-workspace](./packages/sillajje-workspace/CONTEXT.md): workspace lifecycle and session targeting over the jj boundary.

## Terminology

### Session scratch directories

Two extensions name a per-session scratch directory. The terms are not interchangeable:

- **Workspace** is sillajje's term: a jj workspace, a separate checkout directory tied to a commit.
- **Tempspace** is repo-query's term: its per-session temporary root that holds clone targets.

Use `Workspace` only for the jj concept and `Tempspace` only for repo-query's.

### Config layers

Every extension reads one config file per layer. The two layers are not interchangeable, and their names are fixed:

- **Global config**: the user-wide file at `~/.pi/agent/configs/<extension>.json`. The `dotagents` repo owns this directory and deploys it to every host.
- **Project config**: the per-repo file at `<repo-root>/.pi/configs/<extension>.json`.

_Avoid_: "user config" for the global layer (the human is the user), "project-local config" for the project layer, "settings" for either.

## Relationships

- **sillajje → sillajje-core**: the adapter binds the ports, builds each Action at its factory, and renders its statuses. The core owns composition.
- **sillajje → sillajje-jj**: the adapter builds the jj port and hands it to the core.
- **sillajje-core → sillajje-jj**: Actions compose the boundary's Mutations and Transactions. The boundary owns the jj command line, the deferred-operation transaction, and the parsing of jj output.
- **sillajje-core → sillajje-workspace**: stamp, sync, and fold resolve a Session target through it. The adapter drives workspace lifecycle on harness events.
- **sillajje-workspace → sillajje-jj**: every jj call goes through the typed `Jj` facade. The workspace boundary owns the directory and its registration, not the command line.
- **sillajje-jj → sillajje / sillajje-core / sillajje-workspace**: nothing. The boundary knows jj and none of sillajje's vocabulary — no session, stamp, or fold.
- **sillajje-workspace → sillajje / sillajje-core**: nothing. It takes session keys and a workspaces root as values and owns no session state.
- **sillajje-core → sillajje**: nothing. The core never imports pi.
