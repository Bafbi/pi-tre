# 02 — Argument parser helper

**What to build:** A pure helper function `parseRebaseFoldArgs` that extracts the positional `<rev>` and optional `--session <id>` from the args string. Both the `rebase` and `fold` subcommands need this, so build it first and test it in isolation.

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] `parseRebaseFoldArgs(args: string)` returns `{ rev: string; sessionId?: string }`
- [x] Extracts the first whitespace-delimited token as `rev`
- [x] Extracts `--session <id>` when present (the flag and value are separate tokens)
- [x] Returns `sessionId: undefined` when `--session` is absent
- [x] Edge cases handled: empty string returns `{ rev: "" }`, missing rev returns `{ rev: "" }`, extra whitespace trimmed, unknown flags ignored, repeated `--session` uses the last occurrence
- [x] Unit tests in table-driven style (matching `metadata.test.ts` and `state.test.ts` patterns)
- [x] Passes `mise //extensions/sillajje:check` (lint + typecheck + test)

## Answer

Implemented as a dedicated module `extensions/sillajje/src/rebase-fold.ts` exporting the `RebaseFoldArgs` interface and the pure `parseRebaseFoldArgs(args: string): RebaseFoldArgs` function. A standalone module (rather than inline in `index.ts`) keeps the shared rebase/fold domain in one place for tickets 03/04, matching the repo's pattern of pure helpers in dedicated modules (`metadata.ts`, `status-pill.ts`, `path-redirect.ts`).

Semantics (per PRD "first positional token" + the edge cases above):
- `rev` is the first token that does not start with `-`; extra positional tokens are ignored.
- `--session <id>` consumes the following token as `sessionId`; repeated flags use the last occurrence.
- Unknown flags (any `-`-prefixed token) are ignored; a trailing `--session` with no value is ignored.
- Empty or flag-only input returns `{ rev: "" }` — callers treat an empty rev as a usage error.

Tests: `extensions/sillajje/test/unit/rebase-fold.test.ts` — 13 cases covering the checklist. `mise //extensions/sillajje:check` passes (246 tests total, no lint/typecheck issues in the new files).
