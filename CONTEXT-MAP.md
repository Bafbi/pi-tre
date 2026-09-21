# Context Map

`pi-tre` is a monorepo of Pi extensions. Each extension is its own context, with its own glossary where one is resolved.

## Contexts

- [leaf-copy](./extensions/leaf-copy): copies editor text or the last leaf message to the clipboard
- [repo-query](./extensions/repo-query/CONTEXT.md): clones git repositories into a per-session tempspace and answers questions with a subagent
- [sillajje](./extensions/sillajje/CONTEXT.md): auto-versioning for Pi sessions built on jj
- [stale-write-guard](./extensions/stale-write-guard/README.md): blocks `edit` and `write` after a stale read

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
