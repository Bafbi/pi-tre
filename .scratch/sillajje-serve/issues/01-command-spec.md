# 01 — Serve command spec in sillajje-core

Status: ready-for-agent

`SERVE_ARGS` and `SERVE_HELP` belong beside the other specs so the adapter
imports them the same way it imports `ARCHIVE_ARGS`.

- `packages/sillajje-core/src/args.ts`: add
  `SERVE_ARGS = { name: "serve", usage: "serve [-s|--session <id>] [--stop|--status]", flags: [session, stop, status], exclusive: [[session,stop],[session,status],[stop,status]] }`,
  and `SERVE_HELP` with one line per flag.
- `packages/sillajje-core/src/index.ts`: export both.
- No `createServe` action: Serve composes no jj operation and stays in the
  adapter. This spec is pure data, so it belongs with the parser.

## Acceptance

`parseCommandArgs("serve -s @ --stop", SERVE_ARGS)` returns a usage error;
`serve`, `serve -s x`, `serve --stop`, and `serve --status` parse.
