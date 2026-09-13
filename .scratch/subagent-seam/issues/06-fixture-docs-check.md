# 06: Protocol fixture, docs, and full check

**What to build:** the last-mile verification slice. A replayed-session fixture pins the process backend's parsed event shapes to the installed pi version, so an upstream protocol change fails a test instead of producing silent reading errors. The package README and repo docs document the contract (`runSubagent`, `SubagentBackend`) and both backends with the agreed vocabulary. The full-repo check runs green across all extensions and the new package.

**Blocked by:** 03 — Adopt the seam in repo-query, 05 — Adopt the seam in sillajje.

**Status:** done

- [x] Fixture test fails on protocol drift from the installed pi version.
- [x] README and repo docs use consistent vocabulary: `runSubagent`, `SubagentBackend`, backend names.
- [x] `mise check` is green across all extensions and the package.

**Deviations:** the fixture is a *recorded and scrubbed* session — `packages/pi-subagent/scripts/generate-fixture.ts` runs the installed `pi --mode json -p --no-session` with `PI_TEST_MODEL`, scrubs volatile values (ids, timestamps, cwd, provider, model), and writes `test/fixtures/pi-session.jsonl` plus a `pi-session.meta.json` that records the pi version that produced it (regenerate with `mise run //packages/pi-subagent:generate-fixture`). Drift detection is a version-pin test rather than a live re-record: the replay test compares the fixture's recorded version against the installed `@earendil-works/pi-coding-agent` and fails on a bump, so the fixture is regenerated deliberately and the parser is re-proven against the new shapes (verified by temporarily faking a version mismatch). The replay assertions derive expected usage from the fixture's own assistant `message_end` lines, so regeneration keeps the test valid. The isolation decision was promoted to `docs/adr/0001-subagent-isolation.md` as the PRD suggested; `extensions/sillajje/docs/adr/0002-sub-generator-redesign.md` carries a supersession note for the transport change.