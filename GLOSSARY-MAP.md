# Glossary Map

`pi-tre` is a monorepo of Pi extensions. Each extension is its own context, with its own glossary where one is resolved.

## Contexts

- [repo-query](./extensions/repo-query/GLOSSARY.md): clones git repositories into a per-session tempspace and answers questions with a subagent
- [stale-write-guard](./extensions/stale-write-guard/README.md): blocks `write` until the agent has read the whole current file

## Terminology

### Tempspace

repo-query names its per-session scratch directory a **Tempspace**: the temporary root that holds clone targets.

### Config layers

Every extension reads one config file per layer. The two layers are not interchangeable, and their names are fixed:

- **Global config**: the user-wide file at `~/.pi/agent/configs/<extension>.json`. The `dotagents` repo owns this directory and deploys it to every host.
- **Project config**: the per-repo file at `<repo-root>/.pi/configs/<extension>.json`.

_Avoid_: "user config" for the global layer (the human is the user), "project-local config" for the project layer, "settings" for either.
