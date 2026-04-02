# stale-write-guard

Pi extension that prevents stale file mutations.

## Goal

If a file changed since the agent last read it, block `edit`/`write` and force a fresh `read` first.

This reduces accidental overwrite when files are modified externally.

## Behavior

- **Existing file + no fresh read** -> block mutation
- **Existing file + read is stale** -> block mutation
- **Existing file + read is fresh** -> allow mutation
- **Non-existing file (new write)** -> allow mutation

## Debug command

```text
/stale-write-guard-debug [on|off|status|toggle|dump]
```

- `on/off/toggle`: control debug widget + status
- `status`: show current debug state
- `dump`: generate a full diagnostic report into editor text

The dump includes:
- runtime/session metadata
- tracked files and mtimes
- current block/allow decision per file
- recent extension events
- ignored tool errors summary

## Install

### From repo package (when GitHub repo is live)

```bash
pi install git:github.com/Bafbi/pi-tre
```

### One-off from local checkout

```bash
pi -e ./extensions/stale-write-guard/src/index.ts
```

## Dev

From repo root:

```bash
mise run check
mise run test
```

Relevant code:
- `src/index.ts` (event wiring + command)
- `src/guard.ts` (stale decision logic)
- `src/state.ts` (in-memory tracking)
- `src/path.ts` (path normalization/canonicalization)
