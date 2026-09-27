# 03 — Adapter command and lifecycle hooks

Status: ready-for-agent

`extensions/sillajje/src/index.ts` drives the controller.

- Create one `const serve = createServeController()` in the extension factory
  (it binds nothing until `start`).
- `handleServe(args, ctx)` parses `sessionDefault(args)` against `SERVE_ARGS`.
  `--stop` and `--status` act on the singleton. A bare re-invoke while running
  reports the live URL and changes nothing. A start resolves `@` to
  `state.getSessionKey()`, then `buildPorts(...).workspaces.resolveTarget`,
  renders `renderSessionFailure` on a bad target, and starts on `wsPath`.
- Footer: `ctx.ui.setStatus("sillajje-serve", "serve: " + publicUrl)` after
  start, `undefined` after stop; `publicUrl` is the first LAN URL, else
  localhost. The start notification lists every URL so one is copyable.
- Stop sites: `session_shutdown` always; `handleArchive` after a successful
  archive of the served session; `handleFold --archive` after a successful
  archive of the served session; `markMissingWorkspaceAndNotify` when the
  served session is the current one; the controller's `onRootGone`.
- Register `sillajje:serve`; add `serve` to the retired-form suggestion list
  and the known subcommand list in the `input` guard.

## Acceptance

Integration tests: start reports a URL and sets the footer; `--status` reports;
`--stop` clears; archive stops the server.
