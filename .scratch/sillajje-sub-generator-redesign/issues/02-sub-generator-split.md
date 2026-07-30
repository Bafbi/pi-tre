# 02 — Split sub-generator: generateHeader() + generateTrace()

**What to build:** The `sub-generator.ts` module is refactored. The old single `generate()` function (which produced both subject and summary in one call) is replaced by two focused functions: `generateHeader()` and `generateTrace()`. Both use the existing `SpawnFn` adapter and spawn `pi -p --no-session --no-tools` (adding the `--no-tools` flag to prevent the model from accessing tools). A shared retry wrapper is extracted: 3 attempts per call, retrying on process failure (non-zero exit, timeout) and empty output. On exhaustion, header falls back to `deriveSubject(prompt)`, trace falls back to empty string.

**Blocked by:** 01 (needs `subGeneratorModel`, `subGenerator.timeoutMs`, and `message.body.trace.detail` from config)

**Status:** ready-for-agent

- [ ] `generateHeader()` function: spawns `pi -p --no-session --no-tools -m <model>` via `SpawnFn`
- [ ] Header prompt: asks the model to produce one dual-prefix subject line (`<interaction-type>/<conventional-commit>: <description>`). Classifies interaction type from the full transcript and diff.
- [ ] Header output parsing: first line of stdout is the subject, rest discarded. Trim whitespace.
- [ ] `generateTrace()` function: spawns `pi -p --no-session --no-tools -m <model>` via `SpawnFn`
- [ ] Trace prompt: three variants gated by `detail` config:
  - `"high"` — ask for 2-4 sentence narrative (problem, approach, outcome)
  - `"step"` — ask for numbered steps (what was done and why)
  - `"decision"` — ask for key insights, discoveries, and trade-offs
- [ ] Trace output: entire stdout is the trace (freeform, no parsing beyond trimming)
- [ ] Shared retry wrapper: up to `maxAttempts` (from config) attempts per call. Retry on: non-zero exit code, timeout, empty/whitespace output
- [ ] Fallback on exhaustion: header → `deriveSubject(prompt)`, trace → empty string
- [ ] `createSpawnFn()` unchanged (still spawns with `child_process.spawn`)
- [ ] Old `generate()` function removed
- [ ] Unit tests: header prompt includes `--no-tools` in args array, correct model from config, `--no-session` flag
- [ ] Unit tests: header parsing — single-line output, multi-line output (takes first line), empty output (retried)
- [ ] Unit tests: trace prompt for each detail level contains correct instructions and context variables
- [ ] Unit tests: retry wrapper — exhausts retries then falls back, does not retry on success
- [ ] Unit tests: fallback behavior — header returns `deriveSubject(prompt)` result, trace returns `""`
- [ ] Unit tests: parameterized — both functions tested independently with the same mock `SpawnFn` pattern from existing tests
