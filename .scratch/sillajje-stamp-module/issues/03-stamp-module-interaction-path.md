---
Type: task
Status: ready-for-agent
---

# 03 — Stamp module: the Interaction stamp path

**What to build:** The stamp module exists with a single entry `stamp(input, deps)` handling the Interaction stamp end-to-end. Given pi's own `Message[]` transcript for an Interaction and the session's workspace, it derives the prompt, response, thinking count, tools, and elapsed; runs the Sub-generator for Header + Trace in parallel; assembles the config-gated Commit body; and seals the working copy as a new jj Change with the session bookmark updated. It streams typed statuses during execution and returns a value-based result. The Sub-generator model/retry/timeout and body-section config come from the sillajje config, extracted by the module itself.

This adds the type-only dependency on the pi ai package for pi's `Message` type. The adapter is not yet rewired — the module is verified through its own unit tests crossing the mocked seams.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `stamp(input, deps)` returns `{ ok: true, subject, rev: "@" }` for a successful Interaction stamp with a mocked jj seam and mocked Sub-generator
- [ ] The seal sequence runs in order through the injected jj seam: diff fetch, prior-descriptions fetch, update-stale, describe, bookmark set, jj new
- [ ] Prompt (first user message), response (last assistant text), thinking blocks, tool names/call count (toolCall blocks), and elapsed (message timestamps) are derived from the transcript and appear in the Commit body / Sub-generator transcript
- [ ] Statuses stream: the three phases, plus warning statuses when the Sub-generator falls back (header fallback → prompt-derived subject; trace fallback → omitted trace)
- [ ] Expected failures (jj non-zero exit, Sub-generator exhaustion) return `{ ok: false, reason: "failed" }` with an error status; the module never throws for them
- [ ] A throwing `onStatus` sink does not corrupt the stamp
- [ ] `user_prompt` header mode and the config-gated body sections behave per config
- [ ] `setSessionBookmark` is exported from the module and stamps through the injected jj seam
- [ ] The interaction input is pi's `Message[]` (type-only dependency on the pi ai package)
- [ ] lint + typecheck + the module's unit tests pass
