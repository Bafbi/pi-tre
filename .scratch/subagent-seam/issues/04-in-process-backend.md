# 04: In-process backend

**What to build:** a backend wrapping the pi SDK's agent-session creation. Each call gets a fresh in-memory session, a tools allowlist, an `excludeTools` denylist that keeps the spawner's own tools out (recursion guard), the parent's model and thinking level inherited by default, cooperative abort, and a watchdog timeout that surfaces `timedOut` when a turn hangs past the limit. The backend constructs its own model runtime by default (auth resolved from the extension agent directory) — no caller-side runtime wiring — with an injectable runtime override for tests.

**Blocked by:** 01 — Package scaffold.

**Status:** done

- [x] Backend builds its own model runtime by default; tests override it via the injectable seam.
- [x] Each call starts with a fresh in-memory session; no history leaks between calls.
- [x] Allowlist and denylist are honored; session options are exercised against a stubbed session factory, with no live LLM.
- [x] A hung turn reports `timedOut` past the timeout, and abort works cooperatively.

**Deviations:** model-string support — the backend resolves a CLI string (e.g. `"p2/m2"`) against its runtime via pi's `resolveCliModel`, because both extensions configure models as strings; `onModel`/`onThinkingLevel` are separate callbacks rather than one parent-model callback, so callers can inherit model and thinking level independently. Session creation failure surfaces as an error event plus a code-1 exit event. The watchdog aborts cooperatively and reports `timedOut`; if it fires while the session is still being created, the run finishes without prompting. `runSubagent(task)` now defaults to a shared in-process backend, completing the contract's optional-backend form from ticket 01.

Post-review changes: the timeout is now a wall-clock deadline, not an inactivity watchdog — a turn that streams forever also times out, and the run always reports `timedOut` even when the child ignores the cooperative abort (a 1 s grace force-finishes it). Model strings of the form `"provider/model:thinking"` now apply the parsed thinking level. The unused `agentDir` and `sessionStartEvent` backend options were removed.
