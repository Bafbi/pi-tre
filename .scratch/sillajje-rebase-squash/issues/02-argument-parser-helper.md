# 02 — Argument parser helper

**What to build:** A pure helper function `parseRebaseFoldArgs` that extracts the positional `<rev>` and optional `--session <id>` from the args string. Both the `rebase` and `fold` subcommands need this, so build it first and test it in isolation.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `parseRebaseFoldArgs(args: string)` returns `{ rev: string; sessionId?: string }`
- [ ] Extracts the first whitespace-delimited token as `rev`
- [ ] Extracts `--session <id>` when present (the flag and value are separate tokens)
- [ ] Returns `sessionId: undefined` when `--session` is absent
- [ ] Edge cases handled: empty string returns `{ rev: "" }`, missing rev returns `{ rev: "" }`, extra whitespace trimmed, unknown flags ignored, repeated `--session` uses the last occurrence
- [ ] Unit tests in table-driven style (matching `metadata.test.ts` and `state.test.ts` patterns)
- [ ] Passes `mise //extensions/sillajje:check` (lint + typecheck + test)
