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

- [Design the stamp module interface](issues/01-design-stamp-module-interface.md) — one entry `stamp(input, deps)`: pi `Message[]` | null (refined during ticket 02 grilling — pi's own transcript, no custom interaction type; recorded in [PRD.md](PRD.md)) as the Interaction stamp vs Diff stamp axis + `workspace` + `rev` (default `@`; full seal vs describe-only); injected seams ExecFn, SpawnFn, config (extracted internally), infallible `onStatus` sink with a three-kind status union; value-based `StampResult` (`no-changes` ≠ `failed`). The adapter fetches the transcript from the session at stamp time. Terms added to CONTEXT.md; ADR-0003 records it (updated for the pi-`Message[]` input and session-fetch).

The extract work (ticket 02) is broken into implementation slices 03–06 per [PRD.md](PRD.md).

## Not yet specified

<!-- both fog items graduated with ticket 01: the adapter's status→notification mapping now lives in ticket 02; the bookmark-ensure reuse is decided (module exports setSessionBookmark). -->

## Out of scope

- Fold & rebase choreography into engine functions — future effort, not the stamp module.
- Unified jj port (ExecFn for all jj traffic) — the stamp module takes ExecFn; the rest of the bypass stays.
- Interaction lifecycle interface — future effort.
- Sub-generator host-args relocation (`pi -p` args) — sub-generator stays as-is; the stamp module depends on it as an existing engine module.
