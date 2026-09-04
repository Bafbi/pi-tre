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
- State is a `Map<string, number>` (canonical path -> mtime the agent last
  saw) owned by `src/index.ts`. Do not add fields to it. The guard decision
  needs exactly one number per file.

## Implementation constraints
- Handle symlinks via canonical paths where possible.
- Handle missing files gracefully (new file writes should not fail this guard).
- Use conservative mtime comparisons with tiny timestamp tolerance.
- Keep behavior compatible with `/reload` development workflow.
