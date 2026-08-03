---
Type: task
Status: ready-for-agent
---

# 05 — Adapter: Interaction stamp through the module

**What to build:** The automatic stamping flow is rewired through the stamp module. The adapter uses events only to decide when to stamp; at stamp time it fetches the Interaction's transcript from the session (sliced from the interaction-start boundary marker recorded at interaction start) and hands pi's `Message[]` to the module. It binds the real seams, maps statuses to notifications (phases debug-only, warnings/errors notify), and resets interaction state. The derived interaction state (prompt, response, tools, thinking, elapsed) retires from the session state. The integration fixtures populate the session so the fetch path is exercised.

**Blocked by:** 03 — Stamp module: the Interaction stamp path

**Status:** ready-for-agent

- [ ] An Interaction stamped at `agent_end` produces the same jj Change as before — Header, Trace, Meta, prompt/response sections, bookmark updated — verified via `jj show` in the integration suite
- [ ] Error-ended Interactions still defer and finalize exactly once (on retry continuation, or at the next input / shutdown)
- [ ] Sub-generator fallback and jj failure notifications reach the UI as before
- [ ] The transcript is fetched from the session at stamp time; the boundary marker is recorded at interaction start
- [ ] Retired session-state fields are removed; no dead code remains
- [ ] `extractAssistantText` lives in the module; its unit test imports from there
- [ ] Full test suite + typecheck + lint pass
