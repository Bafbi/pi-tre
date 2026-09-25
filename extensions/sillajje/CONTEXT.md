# Sillajje

Auto-versioning for Pi agent sessions built on jj. Every agent interaction becomes a jj change, leaving a reviewable trail (a *sillage*) of all work done.

## Language

**Interaction**:
One continuous agent run: the prompt that starts it, any steering or follow-up prompts delivered while it runs, and all agent tool calls and responses until the agent stops. The boundary of one jj change.
_Avoid_: Turn, round, exchange

**Sillage**:
The cumulative trail of jj changes left by agent sessions — fully reviewable via `jj log`, `jj show`, and `jj diff`.

**New**:
A `/sillajje:new [-o <rev> | -s <id>]` subcommand that starts a new pi session whose workspace branches from a named Base instead of `trunk()`. A bare invocation is `-s @`: it continues from this session's last seal. `-o` names a revision (`@` is the current workspace's working copy); `-s` names a session whose bookmark is the Base (`@` is this session's last seal). An archived session is a valid Base session; a foreign one is not, and a conflicted bookmark is rejected. The chosen base is recorded in the new session's log, so a reload does not re-resolve it.
_Avoid_: Fork (pi's `/fork` copies session history), clone (pi's `/clone`), resume (it keeps the session, not its tree)

**Sync**:
A `/sillajje:sync -s <id|@> -o <rev>` subcommand that brings a target revision into a session's ancestry as a merge commit, keeping the session's own history intact. The session remains active afterward.
_Avoid_: Rebase (as the subcommand name — it asserts the wrong mechanics), Merge, Update (the jj operation underneath is `jj rebase`)

**Fold**:
A `/sillajje:fold` subcommand that publishes a source delta as one clean change. `-o <rev>` publishes the whole delta — `tree(tip) − tree(base)`, base `fork_point(source, target)` — under a target; `--update <bookmark>` appends only the work since that review bookmark's last fold and advances it. `--name [<branch>]` names the folded change (empty names it `fold-<change id>`). The source branch survives, and a merge in the source range is linearized by the replay. The message is a generated Header and Summary plus a `Ref:` line, never the agent trace. `--land` advances the target bookmark; `--archive` retires a session source.
_Avoid_: Squash (jj's `jj squash` is the primitive underneath; Fold is the publish act)

**Folded source**:
The source tip last published by a Fold, recorded as a `sillajje/folded/<source>/<target>` bookmark. The target half is the review branch the fold was named with (`--name`), or `--update`'s bookmark, or the target's single local bookmark. For a session source the recorded tip is the last seal (the session bookmark), not the workspace working copy, because `@` is the fresh empty child the next interaction stamps. `--update` reads the marker as the next Fold's base, so folding again publishes only what is new.
_Avoid_: Fold base, checkpoint

**Stamping**:
Sealing a change with a generated commit message: the Sub-generator produces the Header (and Trace), the Commit body is assembled, and the change is described. Two axes decide the shape. The Action decides the mechanics: a Session stamp performs the full seal at a workspace's working copy; a Rev stamp describes one revision and nothing else. The Source decides generation: an Interaction transcript plus the diff, or the diff alone. Every Interaction becomes one stamped change.
_Avoid_: Committing (stamping is the session-level act; the jj mechanics underneath are incidental)

**Session stamp**:
A stamp bound to a sillajje session. It always targets that session's working copy and performs the full seal — workspace prep, describe, session bookmark move, and a fresh empty change — as one transaction: either the whole seal appears or nothing does. It fires on the `agent_settled` auto-stamp (with the pending Interaction transcript), `/sillajje:stamp -s @` on the current session, and `/sillajje:stamp -s <id>` on another live session (both diff-only; a foreign transcript is never borrowed).
_Avoid_: Manual stamp (the same entry point serves both entries)

**Rev stamp**:
A stamp bound to a revision, not to a session. `/sillajje:stamp -r <rev>` accepts any revision jj resolves and generates a conventional-commit header from `jj diff -r <rev>`, then describes that change only — no bookmark move, no `jj new`, no `update-stale`. A single `jj describe` is one jj operation, so the stamp is atomic. `--rev @` describes the caller's working copy without sealing it.
_Avoid_: Diff stamp (that names the source axis, not the session link)

**Interaction stamp**:
A stamp whose message is generated from an Interaction transcript plus the diff. It is the layer-2 context of the `agent_settled` Session stamp on the current session. A session stamp without a transcript, a cross-session stamp, and every Rev stamp generate from the diff alone.
_Avoid_: Auto-stamp (what differs is the source, not who triggered it)

**Stamp marker**:
A session entry written after each Session stamp, recording the stamped revision. It is the cursor that tells the extension which Interactions are already stamped and survives a reload.
_Avoid_: Checkpoint (that is a Fold's base), Bookmark (jj's session ref is a different thing)

**Diff stamp**:
A stamp whose message is generated from the diff alone — the `-s @` current-session stamp, the `-s <id>` cross-session stamp, and every Rev stamp. Its Header is a conventional commit without an interaction-type prefix.
_Avoid_: Manual stamp (the `-s` form is equally diff-only)

**Change metadata**:
The programmatically-generated `Meta:` section in a stamp's Commit body, carrying Provenance only: the Source, the ids the stamp touched, the sub-generator model, the fallbacks that fired, and the pi and sillajje versions.
_Avoid_: Telemetry, stats

**Interaction loop**:
The programmatically-generated `Loop:` section in a stamped change's Commit body: tools used, tool call count, elapsed time, and thinking blocks. It renders only on an Interaction stamp; `actions.stamp.loop` selects its fields.
_Avoid_: Telemetry, stats

**Provenance**:
The section an Action contributes that records where its body came from: a stamp's is Change metadata (`Meta:`), a Fold's is its `Ref:` range, and Sync contributes none. Each Action owns its provenance shape; there is no shared Action field.
_Avoid_: Audit log, telemetry

**Source**:
What a stamp's generated message was produced from: an Interaction transcript, a diff, or a revision. A Fold's provenance is its `Ref:` range, not a Source.
_Avoid_: Trigger (the old term conflated the stamp mechanics with the Source)

**Commit description**:
The full jj description: the subject line (the Header) plus the Commit body.

**Commit body**:
The ordered labelled sections after the subject line. A stamp contributes trace, change metadata, interaction loop, user prompt, and agent response; a Fold contributes a summary and a `Ref:` line. Everything reviewable in `jj show`. `actions.<action>.body` selects the sections and their order.

**Sub-generator**:
Two tool-less pi subagents invoked in parallel by the extension through `@pi-tre/pi-subagent`'s in-process backend (no child process) — one produces the dual-prefix subject line (header), the other produces the compressed agent-loop narrative (trace). Inputs: session transcript (user messages + extracted assistant text), the diff, and previous change descriptions.
_Avoid_: Summarizer, sub-agent

**Header**:
The dual-prefix subject line produced by the header sub-generator. Format: `<interaction-type>[/<conventional-commit>][(<optional-scope>)]: <description>` (e.g., `act/feat(auth): add login form`, `explore(sillajje): audit error handling`, `answer: middleware chain explained`). The conventional-commit and scope are optional. When no files changed, omit the conventional-commit. The scope signals which area of the codebase the interaction touched. Configurable via `actions.stamp.header.mode` — can also be set to `"user_prompt"` to use the first line of the user's prompt instead.

**Trace**:
The compressed narrative of the agent's thinking-and-tool loop, produced by the trace sub-generator. Captures what the agent thought about, what tools it called and why, what it found, and what decisions it made — not just the final outcome. Three configurable detail levels: `high` (2-4 sentences), `step` (numbered actions), `decision` (key insights and trade-offs).
_Avoid_: Summary, description

**Dual prefix**:
A two-part prefix taxonomy where the first part describes the agent's mode of operation and the second (optional) describes what changed. Separated by a slash: `<interaction-type>/<conventional-commit>`.

**Interaction types**:
The taxonomy of agent modes that form the first half of a dual prefix. Seven canonical types: `act` (executed, files changed), `plan` (designed/scoped), `explore` (read and navigated the codebase), `research` (investigated external sources), `ask` (asked the user a question), `answer` (answered the user's question), `debug` (diagnosed a problem). The header sub-generator picks the best type from the transcript. All can combine with a conventional-commit prefix when files changed.

## Concurrency

Each Pi session gets its own jj workspace (`sillajje/<session-key>`), so concurrent Pi processes on the same repo never share a working directory. A new workspace branches from the `trunk()` revset, so unlanded work on the main checkout stays out of the session. When `trunk()` resolves to `root()` (the repo has no trunk bookmark), the session starts from an empty tree and sillajje warns. jj handles concurrent operations on one repo natively — bookmarks, working-copy snapshots, and lock files are coordinated by jj itself — so no locking or coordination is needed in the extension. The session-ID collision guard (a numeric `-N` suffix on the session key) covers the pathological case of two sessions sharing an ID.

## Bookmark lifecycle

The `sillajje/<session-key>` bookmark is created at the start of the first interaction (`before_agent_start`) and updated on every Session stamp: the `agent_settled` auto-stamp, `/sillajje:stamp -s @` on the current session, and `/sillajje:stamp -s <id>` from another conversation. Creating it early means the session's `sillajje/<session-key>` ref resolves from the very first interaction (e.g. for `jj show`, `jj diff`, or unarchive). A Rev stamp (`-r <rev>`) never moves a bookmark.

## Log revsets

The user's `~/.config/jj/config.toml` defines three aliases:

- `session` = `trunk()::bookmarks(sillajje/*)` — the tips of active sessions whose base is over the trunk.
- `reconciled` = `trunk()..(children(~(trunk()::)) & trunk()::)` — the commits between each reconciliation merge (a trunk-descendant commit with a non-trunk parent) and the trunk: the session work that was merged into the trunk line. Empty when nothing has reconciled yet.
- `bridge` = `(ancestors(roots(reconciled), 2) & ~reconciled):: & ::trunk()` — the ancestors of trunk linking the parent of the reconciled chain (the branch point where the reconciled work left the trunk's ancestry) up to the trunk itself. Without it those commits hide behind the log's `~` elision.

The log is `immutable_heads()..@ | trunk():: | reconciled | bridge`.
