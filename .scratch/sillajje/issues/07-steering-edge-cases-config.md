# 07 — Steering, edge cases, error handling, and config

**What to build:** Polishes the extension with correct steering behavior, error resilience, and configuration. Mid-stream steering corrections (`streamingBehavior: "steer"`) do not create new changes — already handled by the interaction boundary logic from ticket 04, validated end-to-end here. Errors (sub-generator crash, missing jj binary mid-session, externally deleted workspace directory) surface as user notifications rather than silent failures. Configuration is loaded from `sillajje.sub-generator-model` and `sillajje.workspaces-root`. The session state machine correctly detects and handles stale state (e.g., workspace deleted externally while session thinks it's active).

**Blocked by:** 06 — Archive and unarchive command

**Status:** ready-for-agent

- [ ] Steering does not create a new change: end-to-end test simulating a user prompt → agent starts → user steers → agent continues → only one change stamped
- [ ] Follow-up messages (`streamingBehavior: "followUp"`) create their own change on the next `agent_settled`
- [ ] Configuration loaded from `sillajje.sub-generator-model` (string, model identifier) and `sillajje.workspaces-root` (string, path, default `~/.pi/sillajje`)
- [ ] Missing config: defaults applied, no crash
- [ ] Sub-generator failure: stamps change with placeholder subject + `[generation failed: <reason>]` note, user notified
- [ ] jj binary missing mid-session (e.g., PATH changed): `tool_call` handler falls back gracefully, user notified
- [ ] Workspace directory deleted externally while session is active: detected on next `tool_call` or `agent_settled`, session marked stale, user notified with suggestion to unarchive or start a new session
- [ ] Session ID collision (two sessions with same ID): handled gracefully — second session creates a distinct workspace (append suffix or warn)
- [ ] Concurrent Pi processes (two sessions on the same repo): each has its own workspace, no cross-contamination, jj handles concurrent ops natively
- [ ] Integration test: full steering flow — user prompt → agent tool calls → steering → agent continues → `agent_settled` → exactly one change
- [ ] Integration test: follow-up → `agent_settled` → second change created
- [ ] Integration test: sub-generator crash → change still stamped, user notified
- [ ] Integration test: external workspace deletion → session detects stale state, user notified
