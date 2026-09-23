# Actions are the seams: a hexagonal core over jj

> **Amended by the typed-facade ADR** (`packages/sillajje-jj/docs/adr/0001-typed-facade-over-process-port.md`): `@pi-tre/sillajje-jj` exposes a typed `Jj` facade, not the `ExecFn` process port. `ExecFn` is now an internal seam. The "jj as the domain language" decision below is unchanged.

Sillajje's reusable surface is a set of composed **Actions** — `stamp`, `sync`, `fold`, `archive` — over injected **Ports** (`jj`, `subagent`, `status`), not a set of modules named after one action. The core moves into packages (`@pi-tre/sillajje-jj`, `@pi-tre/sillajje-workspace`, `@pi-tre/sillajje-core`) with no pi imports; the pi extension becomes one **Adapter**, and another interface could drive the same actions.

## Considered Options

**Actions over ports (chosen)** vs keeping per-feature modules (`src/stamp/`, inline rebase and fold). The per-feature shape hid the shared work — the jj exec seam, the deferred transaction, the commit-body sections, session targeting — behind a verb, so every new capability re-implemented it or reached around it.

**jj as the domain language (chosen)** vs a `Vcs` port with generic `commit` / `branch` methods. A least-common-denominator VCS interface cannot express jj's operation log, workspaces, revsets, or deferred integration; the transaction becomes inexpressible. The port is the process (`ExecFn`), and typed jj operations sit above it. A future backend is a sibling package, not an implementation of this interface.

**Adapters call Actions; the core composes (chosen)** vs adapters composing actions. If adapters compose, every adapter re-implements sequencing and the transaction guarantee leaks out of the core.

## Consequences

- The merge action is renamed **`sync`**. It merges upstream into a session's ancestry; it does not rebase the session onto a new base, and the old name asserted the wrong mechanics. `jj rebase` remains the jj operation underneath.
- The commit body becomes ordered named **sections**, and each Action declares the sections it contributes. `stamp` contributes trace, `Meta:`, `Loop:`, prompt, and response; `fold` contributes a summary and a `Ref:` line. This is what makes the published artifact clean without a second builder.
- Provenance is per-Action, not a shared record: the section an Action contributes carries it. `stamp` renders `Meta:` and `Loop:`, `fold` renders `Ref:`, `sync` renders none. ADR `packages/sillajje-core/docs/adr/0002-provenance-is-per-action.md` supersedes the `action` / `source` split named here.
- The exec and spawn test seams move from module globals into the injected dependency bundle.
- The migration is a strangler: tested modules move into the packages unchanged, and the pi adapter is slimmed last.
