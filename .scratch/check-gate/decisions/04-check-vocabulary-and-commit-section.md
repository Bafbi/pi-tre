# Check vocabulary, Records, and the commit section

Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

What words and what persisted shapes does a check run leave behind?

A check run touches four existing seams, and each has its own vocabulary. The ticket settles all four together, so they do not drift.

- **Status events.** The check action emits `phase` events through the status sink, and the adapter renders them as Progress. What phases does one check emit, and does a failing check emit an `error` status (which notifies) or only its result?
- **Records.** `extensions/sillajje/src/record.ts` writes a start record then a terminal done/failed/noop record per operation. Does a check run become a new `RecordOperation`, and what fields does it carry — check name, exit code, duration, output digest, the tree id it ran against?
- **The commit body.** A stamped change should say its checks failed. Is that a new section (`Checks:`), where does it sit in `actions.stamp.body` order, and does it render only on failure? A green run is noise in every commit.
- **The glossary.** Which new terms does `extensions/sillajje/CONTEXT.md` gain, and which existing ones does a check reuse? Candidates: `Check`, `Check run`, `Gate`, `Trigger`. The glossary forbids a second word for `Record`, `Marker`, `Provenance`, `Status event`, `Outcome`, or `Progress`.

## Answer

Decided with the user.

**The commit always records the gate, in one line.**

A green run renders, because absence is ambiguous: a reader seeing no `Checks:` cannot tell a green gate from a repo that declares no checks. The line names each check that ran for that trigger, its verdict, and its duration. It does not name the command; the command is in the versioned config at that revision, and the Record carries it for diagnosis.

```
Checks: check passed (12.4s)
Checks: check failed (exit 1, 12.4s); ci passed (3m 2s)
Checks: check waived (integration DB unavailable)
Checks: ci waived (--no-check)
```

- Only checks the gate actually ran appear. A settle stamp says nothing about a publish-only check.
- A gate that ran no checks renders no section. A skipped gate (empty change) renders nothing either.
- A Fold renders the same line from its publish gate. A `--no-check` Fold records the flag as the waiver's reason, so the published change says it went out unverified.
- No check output reaches the commit. A body is for review, not for 50KB of stderr.

**The glossary gains four terms**, written into `extensions/sillajje/CONTEXT.md`:

- **Check**: a named shell command declared in project config, run at one or more Triggers. Its name is its identity, in Status events, Records, the `Checks:` section, and the report to the agent. It runs in the session workspace, and its exit code is its verdict. _Avoid_: hook, pre-commit, validation, lint.
- **Gate**: the set of Checks a Trigger selects, run together as one unit — the settle Gate, the publish Gate, the on-demand Gate. Red if any Check in it is red. It is the thing that reports, loops, and records, not the individual Check. _Avoid_: suite, batch, pipeline.
- **Check report**: what a red Gate hands the agent — the raw output of every failing Check, truncated the way a bash tool call truncates, with the full output left in a log file outside the workspace. Not the commit's `Checks:` line, which is the one-line verdict that outlives the session. _Avoid_: error message, failure output.
- **Waiver**: the recorded reason a red Gate did not block. One term, two surfaces: the agent at settle gives a reason that ends the loop; the user at publish passes `--no-check`. _Avoid_: bypass, skip, `--no-verify`.

**Mechanism decisions, with why.**

- `PhaseCode` (`action.ts:27`) gains `checking`; a phase is emitted per check with `target` set to the check's name, so Progress names the check that is running.
- The terminal red emits `error` with code `checks-failed`; a waiver emits `warning` with code `checks-waived`. The adapter already notifies on both, so no new rendering path exists.
- One Record per gate run, not one per check: an operation is the gate, and `recordOperation` (`record.ts:241`) already writes start then terminal. Its fields are the trigger, the attempt number, the diff digest, and a `checks` array of `{name, status, exitCode, durationMs, reason}` where status is `passed` | `failed` | `timed-out` | `waived` | `skipped`.
- The section key is `checks` in `StampBodySection` and `FoldBodySection`. It sits after `trace` in the stamp body and after `ref` in the fold body, so a failure notice reads early, next to the narrative. `actions.stamp.body` and `actions.fold.body` both accept it.
- `STAMP_BODY_SECTIONS` (`config.ts`) gains `checks` in that position, which makes it a default section and regenerates the JSON schema.

**Rejected.** A `Check:` singular label (the section lists many), and a separate `FoldChecks:` section (one shape, two bodies).
