# 04 — Change stamping

**What to build:** On `agent_settled` for a new interaction (not a steering correction), the extension stamps a jj change in the workspace with a full commit body. The body contains: the user's prompt, a programmatic metadata block (tools used, call count, elapsed time, thinking blocks, session ID), and the agent's final text response. The `sillajje/<session-id>` bookmark is set to the working-copy commit. The subject line is a simple placeholder derived from the user prompt. After this ticket, a full interaction produces a recorded jj change — `jj log` shows it, `jj show` displays the body, `jj diff` shows file changes. The sub-generator (AI subject and summary) comes in ticket 05.

**Blocked by:** 03 — Path redirection

**Status:** complete

**Implementation notes:**
- Stamping happens on `agent_end` (not `agent_settled`) because `agent_settled` does not reliably reach extension handlers in this Pi version. `agent_settled` is still wired for logging.
- Subject derivation is a placeholder — uses first line of user prompt, not sub-generator. Issue 05.
- After stamping, `jj new -m "sillajje: continue <sessionId>"` is called to create a fresh working copy for the next interaction.
- Elapsed time has a known imprecision: see issue 04b.

- [x] Interaction boundary detection: tracking flag distinguishes new interactions (`streamingBehavior !== "steer"`) from steering corrections
- [x] Interaction data captured: user prompt (from `before_agent_start`), agent response (from last assistant message), tool call names and count (from turn events)
- [x] `metadata.ts` module with `build(meta)`, `deriveSubject(prompt)`, `buildCommitBody(data)`
- [x] Metadata block includes: `tools_used`, `tool_calls`, `elapsed` (seconds with one decimal), `thinking_blocks`, `workspace` (bookmark name), `generated_by: sillajje`
- [x] `agent_end` handler constructs commit body: placeholder subject + user prompt + metadata + agent response
- [x] `jj describe -m "<body>"` run in workspace to set the commit description
- [x] `jj bookmark set sillajje/<session-id> -r @` run in workspace
- [x] Handler no-ops when state is inactive
- [x] Handler no-ops when the interaction was steering-only (no new interaction flag)
- [x] Empty interactions (no file edits) still produce a change with full description — the jj change is empty but the body is complete
- [x] Unit tests for `metadata.ts`: pure function, table-driven with varied inputs
- [x] Unit tests for interaction boundary logic: verify flag is set on fresh prompts and follow-ups, not on steering
- [x] Integration test via ExtensionRunner: simulate a full interaction, then assert jj change exists with correct body content, assert bookmark points to the change
- [x] Integration test via ExtensionRunner: simulate a steering-only interaction, assert no change is created
- [x] Integration test via ExtensionRunner: simulate two consecutive interactions, assert two separate changes with correct bookmarks
- [x] Integration test via ExtensionRunner: simulate follow-up, assert separate change created
