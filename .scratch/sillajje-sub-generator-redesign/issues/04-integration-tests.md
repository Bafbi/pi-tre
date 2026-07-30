# 04 — Integration tests

**What to build:** Update the integration test suite in `change-stamping.test.ts` to verify the new sub-generator behavior end-to-end. Tests cover: dual-prefix subjects appearing in stamped changes, trace content at each detail level in the commit body, config-gated sections being present or absent, and fallback behavior when the sub-generator is unavailable. All existing stamping tests must continue to pass — the fallback path (`deriveSubject` when pi is unavailable) is unchanged and acts as a regression safety net.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] Test: stamped change has a dual-prefix subject (e.g., `act/feat: ...` or `answer: ...`) when sub-generator succeeds
- [ ] Test: trace content appears in the commit body under "Trace:" section at each detail level (`high`, `step`, `decision`)
- [ ] Test: when `message.body.user_prompt: false`, the Prompt section is absent from the commit body
- [ ] Test: when `message.body.response: false`, the Response section is absent
- [ ] Test: when `message.body.meta.enabled: false`, the entire Meta block is absent
- [ ] Test: when individual meta fields are toggled off, only those fields are absent from the Meta block
- [ ] Test: when `message.header: "user_prompt"`, the subject is the first line of the user's prompt (no sub-generator call)
- [ ] Test: fallback — when sub-generator is unavailable (pi not on PATH), header falls back to `deriveSubject(prompt)` and trace is absent
- [ ] All existing stamping tests continue to pass (steering, multiple interactions, followUp, elapsed accumulation)
- [ ] Tests use the existing `ExtensionRunner` pattern from `change-stamping.test.ts`
