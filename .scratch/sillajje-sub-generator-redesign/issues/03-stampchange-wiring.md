# 03 — Wire into stampChange + config-gated body assembly

**What to build:** The `stampChange` closure in `index.ts` is refactored to call `generateHeader()` and `generateTrace()` in parallel via `Promise.all`. When config disables a sub-generator (`header: "user_prompt"` or `trace.enabled: false`), the corresponding call is skipped entirely — no process spawned. The commit body is assembled from config-gated sections: header (always present), trace, user prompt, metadata (with individual field toggles), and agent response. The `buildCommitBody` function in `metadata.ts` is updated: `summary` renamed to `trace`, `CommitBodyData` interface updated accordingly.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] In `stampChange`, call `generateHeader()` and `generateTrace()` in `Promise.all` (when both enabled by config)
- [ ] When `message.header` is `"user_prompt"`, skip header call and use first line of prompt directly
- [ ] When `message.body.trace.enabled` is `false`, skip trace call
- [ ] When only one sub-generator is enabled, call just that one (no `Promise.all` needed, but same code path)
- [ ] Pass `activeConfig.subGeneratorModel` to both calls
- [ ] Pass `activeConfig.subGenerator.timeoutMs` to `createSpawnFn()` (or pass config to generate functions)
- [ ] Pass `activeConfig.message.body.trace.detail` to `generateTrace()`
- [ ] On header fallback (returned `subject`), use it as the commit subject
- [ ] On trace fallback (empty string), omit the Trace section from the body
- [ ] Update `buildCommitBody` in `metadata.ts`:
  - `CommitBodyData.summary` renamed to `CommitBodyData.trace`
  - `buildCommitBody` uses `data.trace` instead of `data.summary` in the "Trace:" section
- [ ] Assemble body sections based on `message.body.*` config:
  - `user_prompt: false` → omit Prompt section
  - `response: false` → omit Response section
  - `meta.enabled: false` → omit entire Meta block
  - Individual meta fields (`tools`, `call_count`, `elapsed`, `thinking_blocks`) toggle fields within the Meta block
- [ ] Notify user on sub-generator failure (existing pattern — `ctx.ui.notify` with "warning" level)
- [ ] Debug log sub-generator results (subject, trace length) — existing pattern
- [ ] All existing stamping integration tests continue to pass (fallback path unchanged)
