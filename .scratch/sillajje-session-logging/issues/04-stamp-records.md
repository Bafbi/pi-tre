# 04: Stamp Records

**What to build:** A Record for every stamp path — the `agent_settled` auto-stamp, a manual `/sillajje:stamp`, a cross-session stamp, a rev stamp, and the shutdown flush. The Record carries the Source (`interaction | diff | rev`), the subject, the stamped rev, the resulting change id, the diff manifest, and the Sub-generator fallbacks that fired. A failed stamp carries the failing jj subcommand, its exit code, and its stderr message. The core surfaces the diagnostics; the adapter writes them.

**Blocked by:** 01 (the diff manifest), 02 (the Record type and write seam).

**Status:** done

- [x] Each stamp trigger writes a start and a terminal Record that names the trigger.
- [x] The Record carries the Source, the subject, the rev, and the change id when the stamp succeeded.
- [x] The Sub-generator fallbacks are recorded as flags, not inferred from the subject text.
- [x] The diff manifest is recorded, naming each omitted path and its reason.
- [x] A failed stamp records the failing jj subcommand, the exit code, and the stderr message.
- [x] The tests read Records off the branch through the extension integration harness, and the diagnostics are asserted there.

## Notes

The core `StampResult` gained a `diagnostics` field (`StampDiagnostics`: source, fallbacks, diff manifest), threaded through the diff-only, interaction, session, and rev paths. The adapter turns it into the Record's `result`, `diff`, and `generator` fields. A failed stamp captures the last error Status event through an optional `capture` on the status sink, so `error.code` and `error.message` carry jj's failing subcommand and stderr. The `debug`-gated argv from the original spec is dropped: the failure message already reproduces the command, so a second copy is noise. Core stamp tests moved from `toEqual` to `toMatchObject` for the success cases so the new diagnostics field does not fail them; the diagnostics content is asserted at the adapter seam.
