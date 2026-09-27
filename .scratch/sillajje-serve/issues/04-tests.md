# 04 — Hermetic tests

Status: ready-for-agent

- `extensions/sillajje/test/unit/serve.test.ts`: `resolveRequestPath` accepts a
  normal path, rejects `..` and `%2e%2e` escapes, and rejects `%00`; the
  controller serves a file, lists a directory, answers `HEAD`, reports
  `status()`, and stops when the root is removed.
- `extensions/sillajje/test/integration/serve.test.ts`: with a jj repo and the
  extension runner, `/sillajje:serve` notifies a URL and sets
  `sillajje-serve`; a fetch of a file written into the workspace succeeds;
  `--status` reports; `--stop` clears the footer; `/sillajje:archive` stops
  the server.

Use `createServeController({ host: "127.0.0.1" })` in the unit tests. Parse
the port from the start notification for the integration fetch.

## Acceptance

`mise run //extensions/sillajje:test` passes with both files.
