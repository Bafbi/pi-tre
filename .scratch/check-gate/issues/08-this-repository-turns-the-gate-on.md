# 08: This repository turns the gate on

**What to build:** pi-tre itself starts using the feature: every interaction that changes the tree is verified by the repository's own gate before it is stamped, and a Fold re-verifies before publishing.

**Blocked by:** 03, 06.

**Status:** done

- [x] The project config layer declares one check named `check`, running the repository's fast gate command, on both `settle` and `publish`.
- [x] The published JSON schema is regenerated and the project config's schema reference resolves.
- [x] A real interaction in this repository stamps with a `Checks:` line, verified against `jj show`.
- [x] The extension's own check task passes for the changed modules.
- [x] The extension's README documents the gate, the config fields, the waiver tool, and the check command, in the glossary's vocabulary.

**Deviation:** Configured at `.pi/configs/sillajje.json` and verified through the integration harness against real jj; a live TUI interaction was not run in this workspace.
