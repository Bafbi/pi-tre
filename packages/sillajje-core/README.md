# @pi-tre/sillajje-core

The composition layer over the jj and workspace boundaries. It owns Actions, the shared status event, the body seam, and the config schema. It knows jj operations, sessions, and message generation, and it never imports pi.

## Actions and ports

An **Action** binds its ports at a factory and returns a plain function. The port record is the capability surface: a host that cannot supply a port cannot compile the action that needs it.

The port records are `JjPort` (`jj`), `WorkspacePort` (`workspaces`), `ConfigPort` (`config`), `VersionsPort` (`versions`), `StatusPort` (`onStatus`), and `SubagentPort` (`run`). `HostPorts` is their intersection. A factory takes the intersection it uses.

```ts
const sync = createSync({ jj, workspaces, onStatus });
const stamp = createStamp({ jj, workspaces, config, versions, run, onStatus });
const fold = createFold({ jj, workspaces, config, run, onStatus });
```

- `createSync` brings a revision into a session's ancestry as a merge. It opens no transaction: one `jj rebase` is one operation.
- `createStamp` returns `{ session, rev }`. A Session stamp seals a session's working copy as one transaction; a Rev stamp describes one revision.
- `createFold` publishes a source range as one clean change under a target, as one transaction. It appends on each fold.
- `createSetSessionBookmark` points a session's bookmark at its working copy.

An adapter calls Actions and renders their statuses. It never sequences two Actions; a needed sequence becomes an Action.

## Status

An Action streams `StatusEvent`s through its `StatusPort`: `phase`, `warning`, and `error`. The sink is infallible; a throwing sink never corrupts the action. Expected failures are returned as `{ ok: false, reason }` values.

## Body seam

A commit description is a subject plus an ordered list of named sections. Each Action declares the sections it contributes. `assembleDescription(subject, sections)` renders them and omits the empty ones. `stamp` contributes `[trace, meta, loop, prompt, response]`; `fold` contributes `[summary, ref]`. The config selects each body through `actions.<action>.body`.

## Config

`SillajjeConfigSchema` owns the config schema and its defaults; `defaultSillajjeConfig()` returns a fresh fully-populated default. `actions.<action>` selects an action's body sections and their detail; `subGenerator` and `subGeneratorModel` are global. The adapter loads the file through `@pi-tre/pi-config`, passing `trusted: ctx.isProjectTrusted()`; see the repo's `docs/adr/0002-extension-config-layout.md`.

## Boundary

This package imports no `@earendil-works/pi-*`. `test/import-boundary.test.ts` fails on a violation.
