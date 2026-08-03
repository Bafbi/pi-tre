---
Status: ready-for-agent
---

# PRD: Stamp module extraction (sillajje engine / pi adapter split)

## Problem Statement

Stamping — the act of sealing an Interaction into a jj Change with a generated Commit body — lives inside the pi adapter: one 1,700-line module that is simultaneously the extension wiring (event handlers, the `/sillajje` command) and the engine. The stamp mechanism has no interface of its own; it is reachable only through pi events and command cases. Consequences:

- **Untestable mechanism**: the stamp flow can only be exercised through a full pi runner against real jj; the integration suite skips wholesale when jj is not on PATH. Failure paths (a failed `jj describe`, a dead Sub-generator) have no fast test.
- **No locality**: understanding "what happens when an Interaction ends" requires reading six event handlers plus two command cases, interleaved with 43 notification call sites and 24 direct `pi.exec` calls that bypass the existing seam.
- **Fragile fixes**: the last two bug fixes to the extension both landed in the event wiring.
- **Redundant derivation**: the adapter accumulates meta from events (prompt, tools, thinking count, elapsed) that the session transcript already contains.

## Solution

Extract the stamp mechanism into a self-contained engine module with a single entry point — `stamp(input, deps): Promise<StampResult>` — that takes its dependencies through injected seams and streams status while it runs. The pi adapter shrinks to a thin binder: it uses events only to decide *when* to stamp, fetches the Interaction's transcript from the pi session at stamp time, and maps the module's statuses and results to notifications.

From the user's perspective, nothing changes: every Interaction still becomes its own jj Change with a generated Header and Trace, the session bookmark still tracks the latest stamp, and `/sillajje stamp` still seals the working copy on demand. The change is invisible except that stamping becomes reliable to maintain.

## User Stories

1. As a pi user, I want every Interaction to become its own jj Change with a generated Header (and Trace when enabled), so that my session leaves a reviewable Sillage.
2. As a pi user, I want the stamp to survive a dead Sub-generator — falling back to the prompt as subject and omitting the Trace — so that my session's Sillage is never lost.
3. As a pi user, I want `/sillajje stamp` to seal the current working copy with a conventional-commit Header derived from the diff, so that I can checkpoint mid-session.
4. As a pi user, I want `/sillajje stamp` with no changes to report "nothing to stamp", so that an empty change is never created.
5. As a pi user, I want the session bookmark updated on every stamp, so that `jj show sillajje/<id>` always resolves to the latest Interaction.
6. As a pi user, I want an error-ended Interaction (timeout, 5xx, rate limit) to be stamped once the retry settles — and never twice — so that a partial Interaction is still sealed exactly once.
7. As a pi user, I want the config-gated body sections (Trace, Change metadata, prompt, response) to keep working exactly as today, so that existing configs behave identically.
8. As a pi user, I want mid-stamp failures to reach the UI as before (Sub-generator fallback warnings, jj failure errors), so that nothing regresses in UX.
9. As a sillajje maintainer, I want the whole stamp pipeline unit-testable with a mocked jj and a mocked Sub-generator, so that failure paths are tested without a pi runner or real jj.
10. As a sillajje maintainer, I want the module to stream typed statuses during execution, so that the adapter maps them to notifications as policy and tests assert on exact emissions.
11. As a sillajje maintainer, I want the module to return value-based results — `no-changes` distinct from `failed` — so that the adapter branches on outcomes, not exception types.
12. As a sillajje maintainer, I want the module to derive the Change metadata (tools, call count, thinking blocks, elapsed) from the interaction transcript, so that meta is made in one place.
13. As a sillajje maintainer, I want the config extraction (header mode, trace detail, body section toggles, Sub-generator settings) inside the module, pinned by tests against the schema defaults, so that the "keep in sync" smell becomes a test.
14. As a fold implementer (future), I want the module to target any rev — `@` gets the full seal, another rev gets describe-only — so that the fold flow can reuse the Diff stamp without an interface change.
15. As the pi adapter, I want to fetch the interaction transcript from the session at stamp time, so that retries and deferred finalization produce a complete transcript without accumulating meta from events.
16. As a pi user, I want the session bookmark to exist from the very first Interaction, so that `before_agent_start` and stamping share one bookmark operation.
17. As a sillajje maintainer, I want the module to never call the UI directly, so that notification policy concentrates in the adapter.
18. As a pi user, I want a throwing status sink to never corrupt the stamp, so that a misbehaving adapter cannot lose an Interaction.
19. As a sillajje maintainer, I want the interaction stamp to always target the working copy, so that the session's current change is always the one being sealed.
20. As a sillajje maintainer, I want the extraction to pass lint, typecheck, and the full test suite.

## Implementation Decisions

### The stamp module

A new engine module exposing exactly one entry point:

```ts
function stamp(input: StampInput, deps: StampDeps): Promise<StampResult>;
```

**Input** — the axis is whether the stamp is derived from an Interaction or not (an Interaction stamp vs a Diff stamp), never manual-vs-auto:

```ts
type StampInput = {
  interaction: Message[] | null;   // pi's own transcript; null → Diff stamp
  workspace: { sessionKey: string; wsPath: string };
  rev?: string;                    // default "@"; "@" → full seal, other rev → describe-only
};
```

- `Message[]` is pi's own message type (from `@earendil-works/pi-ai`, added as a type-only peer dependency — already pinned in the workspace catalog). No parallel interaction type is defined.
- The interaction path always stamps the working copy; `rev` belongs to the Diff path.

**Dependencies** — all injected, none created:

```ts
type StampDeps = {
  exec: ExecFn;                  // jj execution — the existing seam from the workspace module
  spawn: SpawnFn;                // Sub-generator subprocess — the existing seam from the Sub-generator module
  config: SillajjeConfig;        // fully-populated config; the module extracts its own options internally
  onStatus?: (s: StampStatus) => void;   // infallible sink: a throwing sink is caught
};
```

**Status stream** — three kinds; mid-flow failures only (the terminal outcome lives in the result):

```ts
type StampStatus =
  | { kind: "phase";   code: "collecting-diff" | "generating-header" | "sealing-change" }
  | { kind: "warning"; code: "header-fallback" | "trace-fallback"; message: string }
  | { kind: "error";   code: string; message: string };
```

**Result** — expected failures are values, never throws (jj non-zero exit, Sub-generator exhaustion); defects (bugs) may throw:

```ts
type StampResult =
  | { ok: true; subject: string; rev: string }       // sealed / described
  | { ok: false; reason: "no-changes" | "failed" };  // no-changes = Diff-path empty diff (a skip, not an error)
```

### What the module owns

- **Interaction stamp**: derives from the transcript — prompt (first user message text), response (last assistant text), thinking-block count, tool names and call count from `toolCall` blocks, elapsed from message timestamps — builds the Sub-generator transcript, runs Header + Trace in parallel through `spawn`, assembles the Commit body (config-gated sections), then the seal: `update-stale` → `describe` → bookmark set → `jj new`.
- **Diff stamp** (`interaction: null`): fetches `jj diff -r <rev>`, returns `no-changes` when empty, generates a classic conventional-commit Header from the diff, body = Header + `Meta:` line, then: `@` → full seal, other rev → `describe -r <rev>` only.
- **`setSessionBookmark`** — moves into the module, exported so `before_agent_start` reuses the same `ExecFn` path.
- **Config extraction** — the current `getStampConfig` moves in; the sync-drift warning becomes tests pinned against the schema defaults (observable through the interface: Sub-generator model in the spawn args, `user_prompt` header mode in the subject, body sections in the describe body).
- **`extractAssistantText`** and the thinking-count loop move in from the adapter.

### What the adapter keeps

- The when-to-stamp policy, unchanged: `input`/`before_agent_start` begin an Interaction (recording one boundary marker — the entry count at interaction start), `agent_end` stamps (or defers on `stopReason: "error"`), `input`/`session_shutdown` flush a deferred stamp.
- At stamp time: fetch the Interaction's message entries from the session manager (sliced from the boundary marker) and pass the `Message[]` to the module. The session is the canonical store — it holds the complete transcript across retries, which a single `agent_end` never does.
- Bind the real seams (pi.exec as `ExecFn`, the spawn seam, the loaded config, a status→notification mapping: phases debug-only, warnings/errors notify) and reset interaction state after.
- `SessionState`'s derived fields retire (prompt, response, tool names, call count, thinking blocks, elapsed); it keeps lifecycle plus the boundary marker.

## Testing Decisions

A good test verifies external behavior through the module interface — the result, the streamed statuses, and the jj commands emitted through the mocked `ExecFn` — never internals. Fixtures are pi-shaped `Message[]` (real transcript shapes with `toolCall`/`thinking` blocks and timestamps), so the module's derivation is exercised against the interface it actually receives.

**Primary seam** — `stamp(input, deps)` with mocked `ExecFn` + mocked `SpawnFn` + real default config + a collecting `onStatus` sink. Covers: the happy interaction path (result, seal sequence, phases), `user_prompt` header mode, Sub-generator fallbacks (header/trace) with warning statuses, Diff stamp at a rev (describe-only, no bookmark/new), `no-changes`, jj failure → `failed` result + error status, tool/thinking/elapsed derivation visible in the describe body, and the infallible sink.

**Secondary seam (existing)** — the `ExtensionRunner` integration harness with real jj. The helpers populate the session (`SessionManager.appendMessage`) before emitting events — more faithful to real pi, which persists every message into the session. Asserts the produced jj Changes via `jj show` and the existing config-gating behaviors.

Prior art: the mocked-`ExecFn` unit tests in the workspace module, the mocked-`SpawnFn` tests in the Sub-generator module, and the integration `change-stamping` tests.

## Out of Scope

- Fold & rebase choreography extraction — future effort; the Diff stamp's rev targeting leaves the door open.
- Unified jj port (routing all remaining `pi.exec` call sites through `ExecFn`) — the stamp module takes `ExecFn`; the rest of the bypass stays.
- Interaction lifecycle interface — future effort.
- Sub-generator host-args relocation (the `pi -p` command knowledge) — the Sub-generator module stays as-is.
- Richer Sub-generator transcripts — the condensed prompt/tools/response transcript is preserved; feeding the full transcript is a future enhancement.
- Any change to the Commit body format, the Sub-generator prompts, or the status pill.

## Further Notes

- ADR-0003 (stamp module interface) is superseded on two points by this spec: the interaction input is pi's own `Message[]` (no custom interaction type), and the adapter fetches the transcript from the session rather than accumulating it from events. Update it when implementing.
- Domain glossary terms added: Stamping, Interaction stamp, Diff stamp (the axis is source, not mode).
- Effort tracking: wayfinder map at `.scratch/sillajje-stamp-module/` — this PRD is the executable spec behind ticket 02 (extract the stamp module).
- Reference: architecture review report `/tmp/architecture-review-20260803-135144.html` (card 1) and the result/error-patterns research asset.
