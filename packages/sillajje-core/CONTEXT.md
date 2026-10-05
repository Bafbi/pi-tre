# Sillajje core

The composition layer over the jj and workspace boundaries. It owns Actions, the shared status event, and the config schema. It knows jj operations, sessions, and message generation, and it never imports pi.

## Language

**Action**:
A composed capability the core exposes — `stamp`, `sync`, `fold`, `archive` — built from jj operations and the Sub-generator, and driven by an interface. Adapters call Actions and render their statuses; the core owns composition. A body-producing Action declares the sections it contributes.
_Avoid_: Command, operation (a jj operation is the primitive underneath an Action)

**Status event**:
A typed event an Action emits while it runs, through its status sink. A `phase` names a step and may name the step's target; `info`, `warning`, and `error` carry a message. The core emits events and owns their codes; the adapter renders them.
_Avoid_: Log line, telemetry (the debug log is a separate sink)

**Diff budget**:
The cap a body-producing Action applies to a diff before the Sub-generator sees it: a per-file line gate, a whole-diff estimated-token ceiling, and a path omit list. A file over the gate, or matching the omit list, keeps its name and change count in the prompt and loses its content.
_Avoid_: Truncation (a file is inlined whole or left name-only, never cut mid-file), context window (that is the model's limit, not sillajje's cap)
