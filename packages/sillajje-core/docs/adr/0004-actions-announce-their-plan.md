# An Action announces its Plan before it runs

**Status**: accepted

The adapter renders a running Action as a widget above the editor, and until now it learned a step only when the step's Phase arrived. `fold` announced nothing until it had resolved the target and the base, collected the diff, and generated the header and summary, so the longest wait in sillajje showed no feedback at all. `archive` and `sync` were silent through target resolution for the same reason.

An Action now emits a `plan` Status event first, carrying the ordered Phase codes it will run. The renderer draws every step as pending the moment the plan arrives, so the widget starts with the action rather than with its first finished step. A Phase marks its planned step running and closes the ones before it. A planned step whose condition resolves false, or that fails without ending the run, is rendered skipped, never done, because the widget must not report work that did not happen. A step's target is unknown when the plan is announced, so a planned step draws its phrase alone and gains the target when its Phase arrives.

The plan travels as a Status event rather than as a new part of the Action contract. An Action is a plain function bound to its Ports, and a plan returned from the factory would split that contract in two: the ports say what an Action can do, and a separate value would say what it will do.

## Considered Options

- **A plan returned from the Action factory (rejected).** It makes the plan a second contract every host must carry, and a host that drives an Action generically would have to learn it. The Status sink already exists for exactly this direction of traffic.
- **The adapter writes each command's steps (rejected).** The adapter knows the flags, so it could list the steps. It does not know what the Action does with them, so the list drifts from the Phases and the widget lies. `fold`'s skip conditions and `stamp`'s shared shape live in the core.
- **A `plan` Status event, emitted first (chosen).** One event on an existing sink, one ordered code list, and the Phase stream proves the plan as it runs. A Phase the plan omitted is appended, so a drift renders instead of vanishing.
- **Draw at once, with no delay (rejected).** An instant action would flash a five-line checklist. The renderer keeps its 250 ms delay, which is now the threshold that tells a slow Action from a fast one.
- **Mark a skipped step done (rejected).** It keeps the widget tidy and claims a copy that never ran. A skipped step gets its own marker.

## Consequences

- `PhaseCode` gains `resolving-source`. `fold` now emits `collecting-diff`, `generating-header`, and `archiving`, which it previously never announced, so its plan shares the stamp's vocabulary instead of inventing a second name for the same work.
- A plan is a superset of the Phases, in order: every Phase must name a planned step, and a planned step may never emit. `emitPlan`'s doc states that invariant, and the renderer is the side that tolerates the gap.
- `new` is workspace lifecycle, not an Action, so the adapter seeds the renderer's plan itself. No core Action is involved and no Status event is emitted.
- The renderer owns the words and the plan owns the codes. Copy changes stay in `extensions/sillajje/src/progress.ts` and never touch a core test.
- A failure freezes the running step, or the first pending one when the failure lands before its Phase, so an early abort names the step that broke.
- A step that fails without ending the run is skipped, not frozen: a failed seed copy reports its error and post-init still runs, so the widget continues past it without closing it as done.
