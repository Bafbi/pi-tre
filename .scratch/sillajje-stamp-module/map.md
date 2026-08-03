# Sillajje stamp module — wayfinder map

## Destination

The stamp module — a self-contained, async engine module that seals an Interaction into a jj Change — extracted from the pi adapter (`extensions/sillajje/src/index.ts`) and working in place. It takes its dependencies through testable seams, returns an end result, and streams status while it runs; the adapter becomes a thin binder that maps results and status to notifications. The map is done when the module exists, its unit tests cross the mocked seams, the adapter is rewired, and `mise //extensions/sillajje:check` passes.

## Notes

- **Domain**: sillajje (`extensions/sillajje`). Glossary in `CONTEXT.md` — use its terms (Interaction, Commit body, Header, Trace, Sub-generator, Change metadata). "Stamping" is used but undefined in the glossary — resolve the term during ticket 01 via /domain-modeling.
- **Execution carried into the map**: tickets land working code + tests, not just decisions.
- **Skills**: /grilling + /domain-modeling for design tickets; /codebase-design for the interface vocabulary (module, interface, depth, seam, adapter, leverage, locality — use exactly, never "component"/"service"/"API"/"boundary"); /improve-codebase-architecture for the source review (report: `/tmp/architecture-review-20260803-135144.html`).
- **Standing preferences**: "the interface is the test surface" — tests cross the same seams the adapter crosses; "accept dependencies, don't create them" — seams are injected, never created; the engine never calls `ui.notify` — notification policy is the adapter's; two adapters justify a seam.
- **Context**: ADR-0001 (workspace isolation) and ADR-0002 (sub-generator redesign) — no conflicts; ticket 01 may warrant ADR-0003 recording the module's interface.

## Decisions so far

<!-- the index — one line per closed ticket. Empty until the first resolution. -->

## Not yet specified

- Which status events the adapter maps to `ui.notify` vs debug-only — depends on ticket 01's status event union.
- Whether `before_agent_start`'s bookmark-ensure reuses the module's bookmark operation or stays adapter-local — depends on ticket 01's in/out scope.

## Out of scope

- Fold & rebase choreography into engine functions — future effort, not the stamp module.
- Unified jj port (ExecFn for all jj traffic) — the stamp module takes ExecFn; the rest of the bypass stays.
- Interaction lifecycle interface — future effort.
- Sub-generator host-args relocation (`pi -p` args) — sub-generator stays as-is; the stamp module depends on it as an existing engine module.
