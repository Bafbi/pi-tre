# Sillajje Serve — PRD

A `/sillajje:serve [-s <id>] [--stop|--status]` subcommand that exposes a
session's workspace as static files over HTTP on the LAN, for the life of the
pi process.

## Why

Sillajje sessions write artifacts into the workspace — including the HTML
reports the agent authors under `.scratch/`. Today the only way to view them
from another device is to copy the file out by hand. Serve gives the workspace
a URL the user can open on a phone or another machine.

The command keeps the session-targeted subcommand shape: `-s` defaults to
`@`, and only `@` is accepted. Serve is single-session — the one pi process
drives it, so it cannot own another session's workspace lifetime.

## Settled design

Decisions reached by grilling; every one is a user value, not a default.

- **Home**: the `sillajje` extension, as an adapter capability. It is not a
  `sillajje-core` Action — it composes no jj operation. The term is **Serve**
  (`extensions/sillajje/CONTEXT.md`).
- **Lifetime**: in-process singleton. It survives any number of interactions
  and stamps. It stops on pi exit, on the *served* session's Archive (command
  or `fold --archive`), on `--stop`, and when a request finds the served root
  gone. It does not survive `/reload`; restart with the command.
- **Port**: ephemeral, bound to `0.0.0.0`. The command reports the URL. A
  fixed port is never assumed, so concurrent sessions never collide.
- **Exposure**: the whole workspace root, LAN trusted. No auth, no root
  override, no config field.
- **Flags**: `serve [-s|--session <id>] [--stop|--status]`. Only `-s @` (or
  no `-s`) is accepted; any other target is rejected. `--session` is exclusive
  with `--stop` and `--status`; `-h` prints usage. Bare re-invocation while
  running re-reports the live URL and never switches targets.
- **Indicator**: a separate footer key `sillajje-serve`, text `serve: <url>`,
  cleared on stop.

## Serving rules

- Root is the current session's workspace path, fixed at start.
- Request paths are decoded, resolved under the root, realpath-checked for
  containment, and rejected with `400` (bad escape, NUL), `403` (escape), or
  `404` (missing).
- A directory serves `index.html` when present, else a generated listing.
- `Content-Type` from the extension, `Content-Length`, `Cache-Control:
  no-store`, `HEAD` supported.
- A request whose served root is gone answers `404` and stops the server.

## Hardening (added after review)

Each of these closed a code-review finding; none is optional.

- A directory request without a trailing slash `301`s to the slash-normalized
  URL, so a generated listing's relative links resolve.
- `sendFile` opens with `O_NOFOLLOW` and streams the descriptor, so a path
  swapped for a symlink after the containment check fails the open.
  `O_NONBLOCK` keeps a swap to a FIFO from blocking the event loop. The body
  is bounded to the advertised `Content-Length`, so an append or truncation
  after `fstat` cannot change the response length. Files and listings are
  verified against the opened descriptor's real path (`/proc/self/fd`, else
  `/dev/fd`), so an ancestor directory swapped for a symlink cannot escape
  the root. On a platform with neither fd alias, the descriptor check is
  unavailable and the request falls back to the path check, so the
  ancestor-swap race stays open there.
- `start()` reserves the controller before `listen`, so a concurrent start is
  rejected instead of leaking a second bound socket. `stop()` stops accepting
  before it force-closes connections, so a connection accepted in between
  cannot make it hang.
- `localUrl` is derived from the bound host, IPv6 literals bracketed, and
  `lanUrls` is filtered to that host. A specific non-loopback bind makes
  `localhost` unreachable, so the advertised URL must name the bound address.

## Out of scope

HTTPS, auth tokens, directory-root configuration, SPA fallback, and serving
any session other than the current one (`-s` accepts only `@`). Any of these
can be a later issue.

## Acceptance

`mise run //extensions/sillajje:check` and `mise run //packages/sillajje-core:check`
pass. A running server answers a file fetch from `127.0.0.1`, rejects
traversal, reports its URL, and stops when its session is archived.
