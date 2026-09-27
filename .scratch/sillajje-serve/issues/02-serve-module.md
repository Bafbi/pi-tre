# 02 — Serve controller and static file server

Status: ready-for-agent

`extensions/sillajje/src/serve.ts` owns one static HTTP server per pi process.

- `createServeController({ host? })` returns `{ start, stop, status }`.
  `start({ sessionKey, root, onRootGone? })` binds `host` (default `0.0.0.0`)
  on port `0`, records `{ sessionKey, root, port, localhostUrl, lanUrls }`, and
  resolves once the socket listens. `stop()` closes the socket and all
  keep-alive connections. `status()` returns the record or `undefined`.
- `lanUrls` comes from `os.networkInterfaces()`: each non-internal IPv4 with
  `http://<address>:<port>`.
- Request handling: `resolveRequestPath(root, requestUrl)` is pure and
  exported. It parses the URL, decodes the pathname, rejects NUL with `400`,
  resolves under the root, and rejects an escape with `403`. The handler then
  realpath-checks containment, serves `index.html` for a directory that has
  one, else a generated listing, and otherwise streams the file with a
  content type, `Content-Length`, and `Cache-Control: no-store`. `HEAD` sends
  headers only.
- A request whose root is gone answers `404`, calls `onRootGone`, and stops
  the server once.

## Acceptance

Unit tests cover traversal, NUL, a served file, a directory listing, `HEAD`,
and the root-gone stop.
