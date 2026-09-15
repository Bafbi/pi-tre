# Context Map

`pi-tre` is a monorepo of Pi extensions. Each extension is its own context, with its own glossary where one is resolved.

## Contexts

- [leaf-copy](./extensions/leaf-copy): copies editor text or the last leaf message to the clipboard
- [repo-query](./extensions/repo-query/CONTEXT.md): clones git repositories into a per-session tempspace and answers questions with a subagent
- [sillajje](./extensions/sillajje/CONTEXT.md): auto-versioning for Pi sessions built on jj
- [stale-write-guard](./extensions/stale-write-guard/README.md): blocks `edit` and `write` after a stale read

## Terminology

Two extensions name a per-session scratch directory. The terms are not interchangeable:

- **Workspace** is sillajje's term: a jj workspace, a separate checkout directory tied to a commit.
- **Tempspace** is repo-query's term: its per-session temporary root that holds clone targets.

Use `Workspace` only for the jj concept and `Tempspace` only for repo-query's.
