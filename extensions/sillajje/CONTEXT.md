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

**Rebase**:
A `/sillajje rebase <rev>` subcommand that syncs the session: rebases the session working copy onto a target revision, creating a merge commit that brings the target into the session's ancestry. The session remains active afterward.
_Avoid_: Merge, sync-update (rebase is precise and matches the jj operation name)

**Fold**:
A `/sillajje fold <rev>` subcommand that collapses all session changes into a single new conventional-commit change on a target revision. Produces a commit message via the sub-generator, then archives the session as a practical convenience. The session bookmark is left as sillage.
_Avoid_: Squash (jj's `jj squash` is a different operation — fold is about collapsing session history, not descending into a parent)

**Change metadata**:
The programmatically-generated block in the commit body listing tools used, tool call count, elapsed time, thinking blocks, and other observability data.
_Avoid_: Telemetry, stats

**Commit body**:
The full jj description: dual-prefix subject line (header) + trace narrative + optional sections (user prompt, change metadata, agent response). Everything reviewable in `jj show`. Section visibility is controlled by `message.body.*` in the sillajje config.

**Sub-generator**:
Two headless Pi processes (`pi -p --no-session --no-tools`) invoked in parallel by the extension — one produces the dual-prefix subject line (header), the other produces the compressed agent-loop narrative (trace). Inputs: session transcript (user messages + extracted assistant text), the diff, and previous change descriptions.
_Avoid_: Summarizer, sub-agent

**Header**:
The dual-prefix subject line produced by the header sub-generator. Format: `<interaction-type>[/<conventional-commit>][(<optional-scope>)]: <description>` (e.g., `act/feat(auth): add login form`, `explore(sillajje): audit error handling`, `answer: middleware chain explained`). The conventional-commit and scope are optional. When no files changed, omit the conventional-commit. The scope signals which area of the codebase the interaction touched. Configurable via `message.header` — can also be set to `"user_prompt"` to use the first line of the user's prompt instead.

**Trace**:
The compressed narrative of the agent's thinking-and-tool loop, produced by the trace sub-generator. Captures what the agent thought about, what tools it called and why, what it found, and what decisions it made — not just the final outcome. Three configurable detail levels: `high` (2-4 sentences), `step` (numbered actions), `decision` (key insights and trade-offs).
_Avoid_: Summary, description

**Dual prefix**:
A two-part prefix taxonomy where the first part describes the agent's mode of operation and the second (optional) describes what changed. Separated by a slash: `<interaction-type>/<conventional-commit>`.

**Interaction types**:
The taxonomy of agent modes that form the first half of a dual prefix. Seven canonical types: `act` (executed, files changed), `plan` (designed/scoped), `explore` (read and navigated the codebase), `research` (investigated external sources), `ask` (asked the user a question), `answer` (answered the user's question), `debug` (diagnosed a problem). The header sub-generator picks the best type from the transcript. All can combine with a conventional-commit prefix when files changed.

## Concurrency

Each Pi session gets its own jj workspace (`sillajje/<session-id>`), so concurrent Pi processes on the same repo never share a working directory. jj handles concurrent operations on one repo natively — bookmarks, working-copy snapshots, and lock files are coordinated by jj itself — so no locking or coordination is needed in the extension. The session-ID collision guard (a numeric `-N` suffix on the workspace name and bookmark) covers the pathological case of two sessions sharing an ID.
