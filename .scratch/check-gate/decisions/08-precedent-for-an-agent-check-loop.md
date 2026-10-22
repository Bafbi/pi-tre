# Precedent for an agent-facing check loop

Type: research
Status: resolved
Blocked by: —

## Question

How do comparable agent harnesses run checks after an interaction and feed the failure back to the model, and what guards keep the loop bounded?

What to find:

- In pi itself: every existing use of `agent_before_settle` that returns `continue: true`, and the guard each one uses to avoid looping. `examples/extensions/` is the reference.
- In pi: whether any extension or built-in already runs a command and injects its output as a user-visible message, and what entry type it uses (`custom`, `custom_message`, `context_edit`).
- In another harness with a first-class hook system (Claude Code's `Stop`/`PostToolUse` hooks, opencode's plugins, or a similar agent loop): what triggers a check, what the model receives, how the retry budget is expressed, and what happens when the budget runs out.
- Anything that already does "run tests, if red send output to the model, repeat up to N times" as a named feature, and the vocabulary it uses.

Report: the concrete mechanism per system, with file paths, and the guards. No recommendation — the ticket is a fact-finding one.

## Answer

Verified in pi 1.2.0 and in sst/opencode. The Claude Code half is unverified (its repo timed out; the docs live at docs.claude.com and are not in a git repo we can grep).

**pi has no example of a check loop.** `examples/extensions/` has four near-misses and nothing that appends a check result and continues:

- `file-trigger.ts` injects text from a watched file with `pi.sendMessage({customType, content, display: true}, {triggerTurn: true})` — a new run, not a continuation of the current one.
- `git-checkpoint.ts` uses `pi.exec()` at `turn_start` and clears state at `agent_settled`; it uses `agent_settled` for cleanup, never for feedback.
- `auto-commit-on-exit.ts` runs a command at `session_shutdown` and reads the last assistant message from `ctx.sessionManager.getEntries()`.
- `dirty-repo-guard.ts` blocks an action from a `session_before_*` event with `{cancel: true}` and asks the user through `ctx.ui.select`.

**The pi mechanism, from `dist/core/agent-session.js:1536` `_runBeforeSettleBoundary()`:** handlers run once per settle attempt. `result.continue` is OR-ed with `agent.hasQueuedMessages()`, and continuation is refused (`_reportInvalidBoundaryContinuation`) when `canContinue` is false. So the boundary is re-entered after every continuation — the guard has to live in the extension, not in pi.

A green result of that read: the extension must own a per-interaction counter or a persisted marker, because `agent_before_settle` fires again on the continued run and an unconditional `continue: true` loops forever.

**opencode** (a different harness, for the vocabulary question): it has no idle/turn-end hook at all. `packages/plugin/src/promise/session.ts:138-151` exposes 20 hooks (`prompt`, `context`, `compaction`, `generate`, `title`, `model.request`, `http.request`, `http.response`, the three `experimental.ws.*`, `retry`; plus `tool.execute.before/after`, `shell.create.before`, `permission.evaluate`, `aisdk.sdk/language`). Idle is an event, not a hook: `session.idle` (deprecated, `packages/schema/src/session-status-event.ts:46`) and `session.status { type: "idle" }` (`:35`). A plugin subscribes with `ctx.event.subscribe()` (an `AsyncIterable`, `packages/plugin/src/promise/event.ts:3`) or waits with `ctx.session.wait({ sessionID })` (`packages/protocol/src/groups/session.ts:444-455`).

**How opencode appends a message:** `ctx.session.synthetic({ sessionID, text, description?, metadata?, delivery?: "steer" | "queue", resume?: boolean })` (`packages/protocol/src/groups/session.ts:383-390`). The message reaches the model as `role: "user"` (`packages/core/src/session/runner/to-llm-message.ts:287-288`). `resume: false` admits it without scheduling a run; omitting `resume` wakes the model. The `id` field is idempotent — the same inbox id and session is a no-op, so a retried delivery cannot duplicate.

**What that buys the design, stated as fact.** Two independent harnesses separate three things the sillajje design must also separate: whether a message is admitted to the transcript, whether it triggers a run, and whether the same message can be delivered twice. pi folds the last two into `continue: true` plus the extension's own guard. opencode makes admission idempotent by id and leaves scheduling to a flag.

**Unverified.** Claude Code's `Stop` hook, its `stop_hook_active` input, and its block-with-reason output. Not needed to decide the guard: pi's boundary re-entry behavior above already forces an extension-owned guard. Check docs.claude.com before citing Claude Code anywhere.
