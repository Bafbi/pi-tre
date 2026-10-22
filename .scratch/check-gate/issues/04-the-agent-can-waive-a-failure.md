# 04: The agent can waive a failure with a reason

**What to build:** When a check cannot be fixed — a missing database, a broken tool, a failure outside the agent's reach — the agent ends the red gate with a reason instead of burning attempts. The reason is what a reviewer reads later. A user can do the same thing by pressing Escape, which cancels the running check and records the cancellation.

**Blocked by:** 03.

**Status:** done

- [x] A `waive_checks` tool takes a required reason and an optional list of check names, and is registered only when the config declares checks.
- [x] The tool is declared to the model from the first request of the session, not activated on demand.
- [x] The call is refused, with a failed tool result naming the actual failing set, when no gate is red, when a named check is not failing, or when the reason is empty.
- [x] Omitting the check list waives every check that failed in the current report.
- [x] An accepted waiver ends the loop and settles the Interaction. The reason lands in the `Checks:` line and in the Record.
- [x] Escape during a running gate kills the check, records the unfinished checks as waived with reason `cancelled`, and the Interaction still stamps.
- [x] A waiver does not persist beyond the gate run and does not relax a publish gate.
- [x] Tests: accepted waiver, each refusal, per-check waiver versus whole gate, and Escape mid-check, all through the integration harness.
