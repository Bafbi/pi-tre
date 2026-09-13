# 05: Adopt the seam in sillajje (in-process backend)

**What to build:** sillajje's spawn adapter points at the in-process backend; there is no new call-site wiring because the backend owns its model runtime. The retry wrapper, fallback values, and the `fellBack` flag stay as the extension's own layer and behave exactly as today; a `timedOut` outcome is treated exactly like the old timeout rejection so fallback output never changes. Generator calls stop paying process-spawn latency on every retry attempt.

**Blocked by:** 04 — In-process backend.

**Status:** done

- [x] Existing generator tests pass through the adapter with no changes to retry or fallback assertions.
- [x] A hung call fails via timeout, is retried, and still produces the fallback value on exhaustion.
- [x] Generated headers and traces are byte-identical to current output for the same prompt and model.

**Deviations:** the adapter maps the seam back onto the old `SpawnFn` result shape rather than exposing the session: `stdout` carries the final assistant text only (accumulated with `createSafeAccumulator` from delta-kind text events, matching the old text-mode stdout), and a `timedOut` exit maps to a non-zero `code` with a `timeout: <ms>ms` stderr — the same message the old `setTimeout` rejection produced — so the retry wrapper needed zero changes. The adapter reads `--model` out of the `args` array instead of a dedicated parameter, so `SpawnFn`'s signature is untouched. `@pi-tre/pi-subagent` was added as a workspace dependency to `extensions/sillajje/package.json` (it was missing even though the test file imported it). The package now exports `createPushStream` + `PushStream` so consumer tests can script their own backends. The old `child_process.spawn` body was removed; the generator's prompts, `deriveSubject`, retry wrapper, fallback values, and `fellBack` flag are byte-for-byte unchanged, which is what keeps generation output identical.

Post-review fix: the adapter now maps the args' `--no-tools` flag to an empty `tools` allowlist on the in-process session, restoring the old tool-less child. An empty allowlist disables all tools (built-in and extension) — `createAgentSession` resolves `allowedToolNames` to an empty set (verified against pi 0.84.4 `sdk.js`) — so the child cannot load sibling extensions' tools into the session.