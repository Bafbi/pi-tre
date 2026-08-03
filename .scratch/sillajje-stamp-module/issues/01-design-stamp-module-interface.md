---
Type: grilling
Status: resolved
---

# Design the stamp module interface

## Question

What is the stamp module's interface?

Resolve:

- **The seam set** — which dependencies the module accepts (ExecFn for jj, SpawnFn for the Sub-generator, config, logger, status sink) — all injected, none created.
- **The status stream** — how the module streams status during execution (typed status event union + injected sink). User-stated constraint: "an end result but also stream status during the execution".
- **The end result** — the result type and error policy. The module returns structured results; the adapter maps them to notifications (notification policy is the adapter's).
- **In/out scope** — does the module own diff fetch, prior-descriptions fetch, `jj update-stale`, `jj describe`, bookmark set, `jj new`? Does the manual stamp flow (`/sillajje stamp`) share the same interface?
- **Config handling** — does the module extract from `SillajjeConfig` internally (fixing the `getStampConfig` default-sync smell in one place) or receive pre-extracted options?
- **Domain language** — define "Stamping" in `CONTEXT.md`; decide whether ADR-0003 records the interface.

Constraints already stated by the user: self-contained; testable seams; async; an end result but also stream status during execution.

Assets: research on result/error + streaming patterns — [`research/result-error-patterns.md`](../research/result-error-patterns.md)

Use /codebase-design's design-it-twice pattern for alternative interface shapes. Reference: `/tmp/architecture-review-20260803-135144.html` (card 1 — "Stamp pipeline: one deep module, not six handlers").

## Blocked by

(none)

## Answer

Interface decided 2026-08-03 (grilling + design-it-twice + research on result/error patterns, [`research/result-error-patterns.md`](../research/result-error-patterns.md)).

**Shape** — one entry point; statuses pushed through a sink; result values:

```ts
function stamp(input: StampInput, deps: StampDeps): Promise<StampResult>;
```

**Input** — no discriminator; the axis is whether the stamp derives from an Interaction:

```ts
type StampInput = {
  interaction: Interaction | null;   // null → diff stamp (derived from a diff, not an interaction)
  workspace: { sessionKey: string; wsPath: string };
  rev?: string;                      // default "@"; "@" → full seal, other rev → describe-only
};
```

**Interaction** — pi-faithful message format; tool calls positioned in the conversation; no prompt field (the module derives it from the first user text block):

```ts
type InteractionContent =
  | { type: "text"; text: string }
  | { type: "thinking"; text?: string }
  | { type: "tool_use"; name: string; id: string }      // id links call → result
  | { type: "tool_result"; tool_use_id: string };       // content deliberately omitted

type Interaction = {
  messages: Array<{ role: "user" | "assistant"; content: InteractionContent[] }>;
  elapsedMs: number;   // adapter measures across retry segments; module formats
};
```

The module derives the prompt (first user text), the response (last assistant text — `extractAssistantText` moves in), the thinking-block count, and `toolNames`/`callCount` from the `tool_use` blocks — the meta is made by the module.

**Deps** — all injected, never created:

```ts
type StampDeps = {
  exec: ExecFn;                  // jj execution (existing seam)
  spawn: SpawnFn;                // sub-generator subprocess (existing seam)
  config: SillajjeConfig;        // module extracts its stamp options internally
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

**Result** — values, not throws, for expected failures:

```ts
type StampResult =
  | { ok: true; subject: string; rev: string }       // sealed / described
  | { ok: false; reason: "no-changes" | "failed" };  // no-changes = diff-path empty diff (info skip, not an error)
```

Expected failures (jj non-zero exit, sub-generator exhaustion) → `ok: false`; bugs (the module itself throwing) may throw — the adapter catches.

**In/out scope** — the module owns: diff fetch, prior-descriptions fetch, sub-generator orchestration (header + trace parallel), body assembly, and the seal (`jj workspace update-stale` → `jj describe` → bookmark set → `jj new` for `@`; describe-only for other revs). `setSessionBookmark` is exported so `before_agent_start` reuses it. The adapter keeps: when to stamp (event policy incl. deferred finalize), interaction observation, notification mapping, post-stamp state reset.

**Invariants** — the interaction path always stamps the working copy (`rev` belongs to the diff path); `onStatus` is infallible; expected failures are results, defects throw.

**Domain** — terms added to `CONTEXT.md`: Stamping, Interaction stamp, Diff stamp. ADR-0003 records the interface.

*Refinement during ticket 02 grilling (recorded in [PRD.md](../PRD.md)): the interaction input is pi's own `Message[]` (no custom interaction type), and the adapter fetches the transcript from the session at stamp time instead of accumulating it from events. The extract work is sliced into tickets 03–06.*
