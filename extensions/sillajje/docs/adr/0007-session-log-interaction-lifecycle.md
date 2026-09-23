# The session log is the interaction lifecycle

Sillajje derives the interaction lifecycle from pi's session log instead of tracking it in memory. `agent_settled` is the stamp trigger, `getBranch()` supplies the transcript, and a `sillajje/stamp` marker is the cursor that `pi.appendEntry` persists. This removes the `agent_end` defer machinery and makes the extension correct across reload and branch navigation.

## Considered Options

**A state machine owning the transcript, the steering rule, the defer rule, and the stamp decision** (the original proposal) vs deriving the lifecycle from the log. Rejected: `agent_settled` already fires once after retries, compaction, and queued continuations, so the defer rule has nothing left to decide. The state machine would centralize a rule that the host makes unnecessary.

**Stamping on `agent_end` with a pending-finalize defer** vs `agent_settled`. Rejected: `agent_end` fires per low-level run, including the error run that pi retries. That is the only reason the defer rule exists. `agent_settled` is the true end.

**A final-`turn_end` trigger to give each follow-up its own change** vs one change per run. Rejected: pi drains a follow-up inside the same run and never fires `before_agent_start` for it. One change per run matches pi's model.

## Consequences

- **Interaction is the session-level run.** A steering or follow-up prompt folds into the current change. `CONTEXT.md` reflects this.
- **The derived prompt joins every user message in the run**, so a folded steering or follow-up prompt reaches the change body. `deriveInteractionData` owns this, not the core.
- **The session log is the source of truth.** `session_start` and `session_tree` reconstruct the cursor from the last Stamp marker; `session_shutdown` flushes a completed but unstamped Interaction.
- **A manual `/sillajje stamp -s @` writes a Stamp marker too**, so it consumes the pending Interaction and the next auto-stamp does not re-seal it.
- **The stamp's `Meta:` section records the Interaction's session entry range** as `interaction: <first>..<last>`, so a reviewer can map a change back to the session file. The range travels on `InteractionData.range`; the Session stamp input shape is unchanged.
- **Tests move to pure projection fixtures plus behavior-level seam tests.** The flag-level `SessionState` interaction tests and the synthetic event sequences are deleted.
