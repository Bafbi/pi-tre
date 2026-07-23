# 02b — Footer status pill

**What to build:** The Pi footer extension-status line shows a sillajje pill so the user can see session state at a glance without running `/sillajje status`. When active, the pill reads `sillajje: [active] ~/.pi/sillajje/repo/sess` (path shortened like the cwd pill). When archived, it reads `sillajje: [archived] sillajje/<session-id>`. When inactive, no pill appears. The pill updates on every state transition.

**Blocked by:** 02 — Workspace creation and system prompt injection

**Status:** ready-for-agent

- [ ] Pure function builds the pill text from `SessionState`: active shows shortened workspace path, archived shows bookmark, inactive returns `undefined` (no pill)
- [ ] Path shortening reuses the same logic as the footer's cwd display (`~` for home, relative otherwise)
- [ ] `session_start` handler sets the status pill after workspace creation, or clears it when inactive
- [ ] State reset clears the pill
- [ ] `/sillajje archive` and `/sillajje unarchive` handlers update the pill (wired when those subcommands are built in issue 06)
- [ ] Unit tests for the pill-formatting function covering all three lifecycle states
- [ ] Integration test: `session_start` in a jj repo sets a status containing `[active]` and the workspace path; non-jj directory clears the status
