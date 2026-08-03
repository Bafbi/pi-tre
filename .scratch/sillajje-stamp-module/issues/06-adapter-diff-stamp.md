---
Type: task
Status: ready-for-agent
---

# 06 — Adapter: Diff stamp (`/sillajje stamp`) through the module

**What to build:** The manual stamp command stamps through the module's Diff path. "Nothing to stamp" is reported as an info when the working copy has no changes; on success the generated subject is shown; failures reach the UI as errors. The module handles the diff fetch, Header generation, and the seal.

**Blocked by:** 04 — Stamp module: the Diff stamp path; 05 — Adapter: Interaction stamp through the module

**Status:** ready-for-agent

- [ ] `/sillajje stamp` with changes produces the conventional-commit Change and notifies the generated subject
- [ ] `/sillajje stamp` with no changes reports "nothing to stamp" and creates nothing
- [ ] Failure paths notify errors as before
- [ ] Full test suite + typecheck + lint pass
