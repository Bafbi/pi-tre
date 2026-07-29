# 10 — Add unit tests for untested pure function `extractAssistantText`

**What to build:** `extractAssistantText` in `index.ts` is a pure function with zero tests. It filters content blocks by `type: "text"` from assistant messages, handles non-assistant roles, null/undefined content, and join semantics. Add a unit test file covering its full behavior.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Normal case: assistant message with multiple text blocks — returns blocks joined by newlines
- [ ] Non-assistant role (e.g. `"user"`) — returns empty string
- [ ] Null or undefined content array — returns empty string, no throw
- [ ] Content array with no text-type blocks (only tool_use blocks) — returns empty string
- [ ] Empty content array — returns empty string
- [ ] Single text block — returns that text unchanged

