---
Type: task
Status: ready-for-agent
---

# 04 — Stamp module: the Diff stamp path

**What to build:** The stamp module also handles a stamp not derived from an Interaction. Given no transcript, it fetches the diff at a revision through the jj seam, reports "no changes" when the diff is empty, generates a classic conventional-commit Header from the diff via the Sub-generator, assembles the minimal body (Header + Meta line), and applies it — the full seal for the working copy (`@`), describe-only for any other rev — so the fold flow can later reuse this path.

**Blocked by:** 03 — Stamp module: the Interaction stamp path

**Status:** ready-for-agent

- [ ] `stamp({ interaction: null, ... })` at the default rev seals the working copy like the manual stamp flow: diff-based Header, Meta line, full seal
- [ ] A non-`@` rev produces describe-only: no update-stale, no bookmark set, no new change
- [ ] An empty diff returns `{ ok: false, reason: "no-changes" }` without creating anything
- [ ] Sub-generator exhaustion falls back to the conventional-commit default subject with a warning status
- [ ] lint + typecheck + the module's unit tests pass
