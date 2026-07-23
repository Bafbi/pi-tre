# 05 — Sub-generator (AI subject and summary)

**What to build:** After `agent_settled`, the extension spawns a headless `pi -p` process using a cheaper model to generate a conventional-commit subject line and a concise summary of the agent's interaction. The sub-generator receives a mustache-templated prompt containing: the session transcript (user messages, agent tool calls, agent responses — tool outputs excluded to reduce noise), the file diff from `jj diff`, and prior change descriptions as compressed context. Its structured text output (subject on line 1, summary in the remainder) replaces the placeholder in the commit body. `jj show` now displays an AI-generated subject and summary.

**Blocked by:** 04 — Change stamping

**Status:** ready-for-agent

- [ ] `sub-generator.ts` module with interface: `generate(templatePath, context: GenerateContext) → { subject, summary }`
- [ ] Sub-generator spawns `pi -p` via `child_process.spawn` with `--no-session`
- [ ] Mustache prompt template at `prompts/generate.md` with variables: `transcript`, `diff`, `prior_descriptions`, `user_prompt`
- [ ] Transcript extracted from session: user messages + assistant messages (including tool call blocks) — tool result content excluded
- [ ] Diff sourced from `jj diff -r @-` in the workspace (or empty string if no file changes)
- [ ] Prior descriptions sourced from recent sillajje bookmarks
- [ ] Sub-generator model read from config `sillajje.sub-generator-model`
- [ ] Output parsed: line 1 → `subject`, remaining lines → `summary`
- [ ] `agent_settled` handler awaits sub-generator result before stamping the change (or stamps with placeholder then updates via `jj describe` after result arrives)
- [ ] Sub-generator timeout and error handling: if it fails, stamps change with placeholder subject + error note
- [ ] Unit tests for `sub-generator.ts` with mocked `child_process.spawn` — test correct command construction, parsing of output, error paths, timeout
- [ ] Integration test via ExtensionRunner: simulate a full interaction, assert the resulting jj change has an AI-generated subject (not a placeholder) and a summary in the body
