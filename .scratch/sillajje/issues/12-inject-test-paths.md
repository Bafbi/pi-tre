# 12 — Inject config and log paths so tests never touch real `~/.pi/`

**What to build:** Currently `config.test.ts` writes to the real `~/.pi/configs/sillajje.json` and `debug-log.test.ts` writes to the real `~/.pi/logs/sillajje.log`. If the test process crashes or is killed, the user's real config and logs can be corrupted. Make both modules accept optional path overrides so tests use temp directories exclusively.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `config.ts`: add optional `configDir` parameter to `loadSillajjeConfig(repoRoot?, configDir?)` defaulting to `~/.pi/configs`
- [ ] `config.ts`: derive `GLOBAL_CONFIG_PATH` from the new parameter rather than hardcoding `~/.pi/configs/sillajje.json`
- [ ] `debug-log.ts`: add optional `logPath` parameter to `createDebugLogger(options, logPath?)` defaulting to `~/.pi/logs/sillajje.log`
- [ ] `config.test.ts`: pass a temp directory as `configDir` — remove all writes to real `~/.pi/configs/`
- [ ] `debug-log.test.ts`: pass a temp file path as `logPath` — remove all writes to real `~/.pi/logs/sillajje.log`
- [ ] Remove global-path cleanup logic from both test files (no longer needed)
- [ ] All 129 tests still pass with no real filesystem side effects
- [ ] Existing callers (`index.ts`) continue working without changes — the new parameters are optional and backward-compatible

