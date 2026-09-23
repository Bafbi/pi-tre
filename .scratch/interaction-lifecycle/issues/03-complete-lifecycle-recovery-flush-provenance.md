# 03: Complete the lifecycle — recovery, flush, manual consumption, provenance

**What to build:** The lifecycle is correct across reload and branch navigation, seals an Interaction left unstamped at quit, treats a manual Session stamp as consuming the pending Interaction, and records the Interaction's session entry range in the change's `Meta:` section.

**Blocked by:** 02 (Stamp on `agent_settled` from the projected session log).

**Status:** done

- [x] On `session_start` and `session_tree`, the cursor is reconstructed from the last Stamp marker on the current branch.
- [x] A reload between a completed Interaction and its Session stamp re-stamps it on the next settle, without duplicating an already-stamped Interaction.
- [x] A completed but unstamped Interaction is stamped at `session_shutdown`, before the unused-workspace archive.
- [x] A manual `/sillajje stamp -s @` writes a Stamp marker, so the next auto-stamp does not re-seal the same Interaction.
- [x] The sealed body's `Meta:` section contains `interaction: <first>..<last>`, the Interaction's session entry range.
- [x] The metadata unit test asserts the new `Meta:` line.
- [x] The extension check passes.

**Deviations:** (1) The shutdown flush and the manual-stamp Stamp marker landed in 02, as noted there. (2) The range travels on `InteractionData.range`, not a new `SessionStampInput` field, so the Session stamp input shape is unchanged.
