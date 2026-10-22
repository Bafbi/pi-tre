# Trust and workspace safety

Type: grilling
Status: resolved
Blocked by: 01

## Question

Which config layer may declare checks, and what is a check command allowed to touch?

A check is a shell command that sillajje runs unattended. `@pi-tre/pi-config` already refuses the project layer unless the caller passes `trusted: ctx.isProjectTrusted()`, and sillajje already gates on that.

Open sub-questions:

- **Layer.** Project-only, or the global layer too? A global check runs in every repository the user opens, including ones that never asked for it. Project-only is the safe default; a global check is convenient for a personal `mise run check` habit.
- **Untrusted projects.** An untrusted project reads no project config, so it has no checks and the gate silently does nothing. Is silence acceptable, or does the extension say "checks declared but not trusted"?
- **Working directory.** Always the workspace root, or may a check name a subdirectory? `mise run //extensions/x:check` runs from the root anyway.
- **Environment.** Inherit pi's environment whole, or a filtered set? A check inherits `SILLAJJE_POST_INIT`, provider keys, and whatever the shell had. `CI=1` is probably worth setting.
- **Writes.** A check may write to the workspace (a formatter, a codegen step). Does the tree need re-snapshotting before the stamp, and does a check that dirties the tree break the stamp's "no changes" detection?
- **Escapes.** Nothing stops a check from writing outside the workspace. Is that accepted as the cost of running a repo's own command, or does the gate need a guard?

## Answer

Decided with the user.

**Both config layers may declare checks.** A global `checks` list is the default for repos that declare none; a project that declares `checks` replaces it, because the shared loader merges per leaf with arrays replaced. This matches `postInit`, which already merges across both layers, so a global check is no new trust model — it is the same one, with a higher frequency. The blast radius is explicit: a global `checks` list with a `settle` trigger runs in every repo the user opens that declares none of its own.

**The environment is the process environment plus `CI=1`.** A check cannot answer a prompt, so anything interactive must be told non-interactive before it starts; vitest, pnpm, and most formatters read `CI`. `CI` is forced rather than defaulted, so a gate behaves the same on every machine and a stray `CI=0` in a shell cannot make it hang. A filtered allowlist was rejected: it would break the repo's own commands, which are the point.

**A check may write to the workspace, and its writes land in the same interaction's stamp.** jj snapshots the working copy on every command, so the edits are picked up for free by the stamp's own diff read. A check that reformats and then passes has validated the reformatted tree, which is the honest outcome.

Three consequences, decided here rather than left implicit:

- When the gate's run changes the working copy, the `Checks:` line (ticket 04) says so, because the stamp now contains edits no one in the conversation made. Wording is the implementer's; the fact is not optional.
- Those edits also move the diff digest, so a red gate followed by a fixing check counts as progress and does not trip the stall rule from [Feedback to the agent](02-feedback-to-the-agent.md).
- A gate still does not run on an empty change, so a check cannot be the only thing that makes an interaction worth stamping. That interaction stamps nothing, as today.

**Settled without asking.**

- The working directory is always the workspace root. Fixed by [Checks config schema](01-checks-config-schema.md), which has no `cwd` field.
- An untrusted project runs no checks, silently. The loader refuses to read the untrusted project layer at all, so the extension cannot even know checks were declared. The silence is forced by the trust model, not chosen here.
- A check may write outside the workspace. It is the repo's own command under the same trust story as `postInit`; a sandbox around it would be a different feature.
- No re-snapshot step is needed after a writing check, because jj snapshots automatically on the next command.
