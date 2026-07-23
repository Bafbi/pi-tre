# Sillajje

Auto-versioning for Pi agent sessions built on jj. Every agent interaction becomes a jj change, leaving a reviewable trail (a *sillage*) of all work done.

## Language

**Interaction**:
A single user prompt followed by all agent tool calls and responses until the agent emits a final text response (not a tool call). The boundary of one jj change.
_Avoid_: Turn, round, exchange

**Sillage**:
The cumulative trail of jj changes left by agent sessions — fully reviewable via `jj log`, `jj show`, and `jj diff`.

**Workspace**:
A jj workspace — a separate checkout directory tied to a specific commit. Each Pi session creates one, and the agent runs inside it. Derived from `jj workspace list`.
_Avoid_: Sandbox, clone, checkout

**Archive**:
A manual lifecycle action that keeps the jj branch but deletes the workspace directory (via `jj workspace forget` + `rm`). An archived session cannot accept prompts until unarchived.
_Avoid_: Close, delete, prune

**Change metadata**:
The programmatically-generated block in the commit body listing tools used, tool call count, elapsed time, thinking blocks, and other observability data.
_Avoid_: Telemetry, stats

**Commit body**:
The full jj description: conventional-commit subject line + user prompt + change metadata + AI-generated summary + agent's final response. Everything reviewable in `jj show`.

**Sub-generator**:
A headless Pi process invoked by the extension to produce the subject line and summary from: session transcript (sans tool outputs), the diff, and previous change descriptions.
_Avoid_: Summarizer, sub-agent
