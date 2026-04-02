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
- `src/index.ts`: extension wiring + event handlers.
- Prefer small internal modules when logic grows:
  - `src/path.ts`: path normalization/canonicalization
  - `src/state.ts`: in-memory tracking state
  - `src/guards.ts`: tool_call/tool_result guard logic

## Implementation constraints
- Handle symlinks via canonical paths where possible.
- Handle missing files gracefully (new file writes should not fail this guard).
- Use conservative mtime comparisons with tiny timestamp tolerance.
- Keep behavior compatible with `/reload` development workflow.
