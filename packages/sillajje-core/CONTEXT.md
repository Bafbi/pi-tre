# Sillajje core

The composition layer over the jj and workspace boundaries. It owns Actions, the shared status event, and the config schema. It knows jj operations, sessions, and message generation, and it never imports pi.

## Language

**Action**:
A composed capability the core exposes — `stamp`, `sync`, `fold`, `archive` — built from jj operations and the Sub-generator, and driven by an interface. Adapters call Actions and render their statuses; the core owns composition. A body-producing Action declares the sections it contributes.
_Avoid_: Command, operation (a jj operation is the primitive underneath an Action)
