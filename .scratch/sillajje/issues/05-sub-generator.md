# 05 — Sub-generator (AI subject and summary)

**What to build:** After `agent_settled`, the extension spawns a headless `pi -p` process using a cheaper model to generate a conventional-commit subject line and a concise summary of the agent's interaction. The sub-generator receives a mustache-templated prompt containing: the session transcript (user messages, agent tool calls, agent responses — tool outputs excluded to reduce noise), the file diff from `jj diff`, and prior change descriptions as compressed context. Its structured text output (subject on line 1, summary in the remainder) replaces the placeholder in the commit body. `jj show` now displays an AI-generated subject and summary.

**Blocked by:** None — can start immediately. Change stamping (issue 04) is already complete.

**Status:** complete

- [x] `sub-generator.ts` module with interface: `generate(ctx, spawnFn, model) → { subject, summary }`
- [x] Sub-generator spawns `pi -p` via `child_process.spawn` with `--no-session` (via `createSpawnFn()` factory)
- [x] Mustache-style prompt template inlined; variables: `transcript`, `diff`, `prior_descriptions`
- [x] Transcript built from prompt + tool names + response (tracked in SessionState)
- [x] Diff sourced from `jj diff -r @-` in the workspace
- [x] Prior descriptions sourced from recent sillajje bookmark ancestors (top 5)
- [x] Sub-generator model read from config `sillajje.sub-generator-model` (passed from index.ts)
- [x] Output parsed: line 1 → `subject`, remaining lines → `summary`
- [x] `stampChange` awaits sub-generator before stamping; on failure falls back to `deriveSubject(prompt)`
- [x] Sub-generator timeout (30s) and error handling: spawn errors throw → caught in index.ts with placeholder fallback
- [x] Unit tests for `sub-generator.ts` with mocked `SpawnFn` — command construction, parsing, errors, timeout
- [x] Integration test via ExtensionRunner: existing stamping tests pass (fallback to `deriveSubject` when pi unavailable)
