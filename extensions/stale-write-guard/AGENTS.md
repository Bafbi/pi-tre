# AGENTS.md (local: stale-write-guard)

## Extension purpose
Prevent stale writes in Pi coding sessions.

If a file was modified externally after the agent last touched it, the extension must block `edit` / `write` until the agent re-reads the file.

## Design principles
- **Safety first**: protect external user edits from accidental overwrite.
- **Deterministic behavior**: compare canonical paths + mtimes consistently.
- **Low friction**: only block when risk is real; otherwise stay transparent.
- **Clear feedback**: blocking reason should tell the model exactly what to do next (read file again).

## Structure expectations
- `src/index.ts`: extension wiring + event handlers + dump command.
- Small internal modules:
  - `src/path.ts`: path canonicalization
  - `src/guard.ts`: stale decision logic
  - `src/injected.ts`: content injected without a read tool call
- State is a `Map<string, number>` (canonical path -> mtime the agent last
  saw) owned by `src/index.ts`. Do not add fields to it. The guard decision
  needs exactly one number per file.

## Load order constraint
The guard must load after any extension that rewrites tool input paths
(sillajje). Pi runs `tool_call` handlers in load order and hands the same
args object to `tool_result`, so the guard only sees final paths when it
runs last. If it runs before sillajje, reads record workspace mtimes while
edits check repo-checkout mtimes, and every read-then-edit blocks forever.
Keep `stale-write-guard` last in the `pi.extensions` list in the root
`package.json`. `test/unit/manifest-order.test.ts` pins this.

## Implementation constraints
- Handle symlinks via canonical paths where possible.
- Handle missing files gracefully (new file writes should not fail this guard).
- Use conservative mtime comparisons with tiny timestamp tolerance.
- Keep behavior compatible with `/reload` development workflow.
