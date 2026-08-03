---
Type: grilling
Status: claimed
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
