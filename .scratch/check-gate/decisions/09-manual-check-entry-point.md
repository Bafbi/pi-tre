# Manual check entry point

Type: grilling
Status: resolved
Blocked by: 02

## Question

The schema now carries a `manual` trigger, so a check can be declared to run only when asked. What asks?

Open sub-questions:

- **The command.** `/sillajje:check`, following the colon surface (`docs/adr/0007-colon-command-surface.md`). Does it take `-s <id>` like the other subcommands, or only run in the current workspace?
- **Selection.** Every check, only `manual`-triggered ones, or `--trigger settle|publish|manual` to pick? A bare invocation probably runs every check the workspace has, since "just run the checks" is the intent.
- **Blocking.** The command returns where? A `manual` run happens on a settled session, so there is no `agent_before_settle` to continue. Does a red result open a new interaction (`pi.sendMessage(..., {triggerTurn: true})`, the `file-trigger.ts` shape), or only notify?
- **Rendering.** The report format is ticket 02's answer. Does this command render it as an Outcome, a Progress run, or a transcript message?
- **The agent's own access.** A tool the model can call would let the agent run the gate mid-interaction instead of waiting to settle. Adds a tool to every session's prompt; the alternative is the agent running `mise run check` itself through `bash`, unrecorded.

## Answer

Decided with the user.

**`/sillajje:check` runs every check the target workspace declares.** `--trigger settle|publish` narrows to one Gate. A bare invocation is the "run everything now" request.

**The `manual` trigger value is gone, at the user's call.** A check with no trigger already means "runs when asked", so a `manual` literal was a second word for the same thing. The schema now has two Trigger values, `settle` and `publish`; an absent `triggers` defaults to `["settle"]`; `triggers: []` means on demand only. Amended in [Checks config schema](01-checks-config-schema.md), [Check vocabulary, Records, and the commit section](04-check-vocabulary-and-commit-section.md), and the glossary in `extensions/sillajje/CONTEXT.md`.

**A red result reports and stops.** No turn is started, in any mode. The report is already in the transcript, so "fix it" costs the user one line; a command that silently spends tokens is the surprising side effect the repo's guidelines warn against, and a confirm prompt would make the command behave differently in TUI and print modes.

**The agent gets no check tool.** It already has `bash`, its `bash` calls are redirected into the workspace, and the settle gate runs a moment later anyway. A second tool would cost prompt space in every session that declares checks.

**Mechanism decisions, with why.**

- `-s <id>` is supported and `-s @` is the default, like every other subcommand. The session-target rule in `@pi-tre/sillajje-workspace` answers ownership, archive, and missing-workspace cases, and ticket 03's no-workspace rule applies: refuse rather than invent a temp workspace.
- The report is a `pi.sendMessage` with `customType: "sillajje/check-report"`, `display: true`, and no `triggerTurn`, so the user can read and scroll it and the agent sees it on the next run without a turn starting.
- A green run gets an `info` Outcome naming the checks and their total duration; a red run gets the transcript report plus a `warning` Outcome.
- It writes one Record with `trigger: "manual"`, and no `Checks:` line, because no stamp happens.
- It does not seed or bypass the settle gate. A manual run is evidence for the user, not a cache entry.
- The adapter's old-form guard gains `check` to its known-subcommand list (`index.ts:1280`), so `/sillajje check` gets corrected to `/sillajje:check` instead of falling through.

**Naming note.** The Record's `trigger` field keeps its existing meaning — what reached the operation — and for a check run takes `settle`, `publish`, or `manual`. The glossary's **Trigger** is the Check's declared selector, which has only `settle` and `publish`. Same word, one meaning ("what caused this run"), two granularities; a user-run check records `manual` because that is what reached it.
