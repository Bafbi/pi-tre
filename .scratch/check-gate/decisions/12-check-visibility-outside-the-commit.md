# Check visibility outside the commit

Type: grilling
Status: resolved
Blocked by: —

## Question

Two places could report check state besides the commit body: the header sub-generator, which writes the subject line, and the footer pill, which reports session state.

- **The sub-generator.** Should the header generator be told the gate's outcome, so a subject can say `act/fix(db): retry the pool (tests red)`? The generator currently receives the interaction transcript and the diff, and the subject has a 72-character budget.
- **The status pill.** Should the pill carry a red-gate marker that persists until the next interaction? The pill currently reports session state: active, archived, missing workspace.

## Answer

Decided with the user: **no to both.**

- The header describes what the interaction did. A failure is not an action the interaction took, and the `Checks:` line in the body already carries the verdict exactly, with exit codes and durations. Repeating it in the subject duplicates the one field with a hard length budget.
- A gate result is bound to one tree at one moment. A pill that kept showing it would claim a current state the extension cannot vouch for — the working copy may have changed since. `Progress` covers a running gate and the `Outcome` covers its result; the pill stays about the session.

No code is affected beyond the decision not to pass the gate result into `generateHeader` or `formatPill`.
