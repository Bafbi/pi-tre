# 01: Prefactor the integration harness to write the session log

**What to build:** The integration harness can put messages into the session log, so the adapter's new read path is testable. The runner context exposes the session manager, and a helper writes a user message and an assistant message into the current branch. No user-visible behaviour changes.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] The integration harness exposes the `SessionManager` the runner context reads.
- [x] A helper writes a user message and an assistant message into the session log at the current leaf.
- [x] Existing integration tests pass unchanged.
- [x] The extension check passes.

**Deviation:** Exposed the session manager through a `getSessionManager`/`WeakMap` helper instead of changing `createRunner`'s return type (87 callers), and added `harness.test.ts` to pin the writer's contract.
