# Ports bind once at a factory; capability is the port record

**Status**: accepted

An Action binds its ports at a factory and returns a plain function. The port record is the capability surface. This supersedes the core PRD's earlier `Action { requires; run(input, deps) }` shape over a five-field `ActionDeps` and a runtime `Capability[]`.

## Context

A `requires: Capability[]` array is not checked: `requires: ["repo"]` with a body that calls `deps.spawn` compiles. The union also conflates three things — `repo` and `session` are universal, `subagent` is a port, `transcript` is input data. The boundary packages already bind a port at a factory (`createJj(exec)`, `createWorkspaces(jj, options)`), and the core contract follows them.

## Considered Options

- **One dependency bundle passed to every action (rejected).** Every action receives every port, tests must fake all of them, and a jj-only host cannot build sync without a sub-generator it does not have.
- **A runtime capability array (rejected).** Unchecked, and it restates what the port type already says.
- **Composable port records bound at a factory (chosen).** `JjPort`, `WorkspacePort`, `ConfigPort`, `VersionsPort`, `StatusPort`, and `SubagentPort`. `createSync(ports: JjPort & WorkspacePort & StatusPort)`, `createStamp(ports: HostPorts & SubagentPort)`. A host that cannot supply a port cannot compile the action that needs it.

## Consequences

- The transcript a stamp may carry is input data, not a port. Stamp and fold need the Sub-generator to turn a diff into text whatever the host knows about transcripts.
- `Capability` is not domain language; it does not enter a `CONTEXT.md`.
- A second adapter (a CLI) builds only the actions it can feed, with no runtime refusal.
- A factory takes the intersection of the port records it uses, so it never receives a port it does not bind.
