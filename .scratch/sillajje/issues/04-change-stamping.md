# 04 — Change stamping

**What to build:** On `agent_settled` for a new interaction (not a steering correction), the extension stamps a jj change in the workspace with a full commit body. The body contains: the user's prompt, a programmatic metadata block (tools used, call count, elapsed time, thinking blocks, session ID), and the agent's final text response. The `sillajje/<session-id>` bookmark is set to the working-copy commit. The subject line is a simple placeholder derived from the user prompt. After this ticket, a full interaction produces a recorded jj change — `jj log` shows it, `jj show` displays the body, `jj diff` shows file changes. The sub-generator (AI subject and summary) comes in ticket 05.

**Blocked by:** 03 — Path redirection

**Status:** ready-for-agent

- [ ] Interaction boundary detection: tracking flag distinguishes new interactions (`streamingBehavior !== "steer"`) from steering corrections
- [ ] Interaction data captured: user prompt (from `before_agent_start`), agent response (from last assistant message), tool call names and count (from turn events)
- [ ] `metadata.ts` module with interface: `build(interaction: InteractionData) → string` — produces the metadata block
- [ ] Metadata block includes: `tools_used`, `tool_calls`, `elapsed` (seconds with one decimal), `thinking_blocks`, `workspace` (bookmark name), `generated_by: sillajje`
- [ ] `agent_settled` handler constructs commit body: placeholder subject + user prompt + metadata + agent response
- [ ] `jj describe -m "<body>"` run in workspace to set the commit description
- [ ] `jj bookmark set sillajje/<session-id> -r @` run in workspace
- [ ] Handler no-ops when state is inactive
- [ ] Handler no-ops when the interaction was steering-only (no new interaction flag)
- [ ] Empty interactions (no file edits) still produce a change with full description — the jj change is empty but the body is complete
- [ ] Unit tests for `metadata.ts`: pure function, table-driven with varied inputs
- [ ] Unit tests for interaction boundary logic: verify flag is set on fresh prompts and follow-ups, not on steering
- [ ] Integration test via ExtensionRunner: simulate a full interaction (session_start + before_agent_start + tool_call + tool_result + agent_settled), then assert jj change exists with correct body content, assert bookmark points to the change
- [ ] Integration test via ExtensionRunner: simulate a steering-only interaction, assert no change is created
- [ ] Integration test via ExtensionRunner: simulate two consecutive interactions, assert two separate changes with correct bookmarks
