# Bound the diff content a prompt receives

**Status**: accepted

Every body-producing Action feeds a file diff to the Sub-generator. A working copy can change a generated file with a hundred thousand lines, and the diff is interpolated into the prompt verbatim, so one big file can exceed the model's context, exhaust the retry wrapper, and leave only a fallback subject.

A diff is therefore collected under a budget. `collectDiff` reads the per-file manifest (`Jj.diffFiles`), then splits it in two. A path matching `omit` keeps its name and change count and loses its content whatever its size: lockfiles, minified bundles, source maps, and vendored code are machine-generated and never useful to the generator. A file over `maxLinesPerFile` loses its content too: it is never read into memory.

When nothing is omitted and the remaining lines fit one file's gate, the whole diff is fetched in one `jj diff` and inlined only if the fetched text also passes the token ceiling; a minified file that fits the line gate but not the ceiling falls through. Otherwise each file's section is fetched only while the estimated-token budget lasts, and every file after that is name-only. A dropped file contributes one marker line, so the generator still sees the path: a lockfile-only change yields `chore(deps): …`, never "no changes".

The boundary grows one read over a `DiffSpec` (a rev, or a from/to range with filesets): `Jj.diffFiles` returns the per-file status and line count. `Jj.diff` accepts `filesets`, so one file's section can be fetched alone.

## Considered Options

- **Condense the whole diff string (rejected).** It keeps the current one-read shape, but a monster file is materialized as a JS string before the cap runs. The budget then saves context, not memory.
- **Per-file reads (chosen).** `--stat` is cheap and never prints file content, and `--summary` never elides a path. The pre-fetch line gate keeps a monster file out of memory. The cost is more jj invocations on a large diff.
- **Ship no default ignore list (rejected).** A knob nobody sets is dead. Paths are matched in the core with `matchesOmit`, and the matched files stay visible as one-line markers.

## Consequences

- The token budget is estimated as one token per four characters. The estimate is hermetic and controllable, and it bounds a prompt; it is never a billing or truncation unit.
- The per-file status and count come from two reads paired by order: `--summary` gives the exact path and status, `--stat` gives the count. A length mismatch is a decode failure, not a silent skip.
- `subGenerator.diff` has three knobs: `maxTokens` (12,000 estimated tokens), `maxLinesPerFile` (400), and `omit` (a default glob list). `omit: []` disables path omission.
- Dropped content emits one `diff-condensed` info status naming the omitted count. A condensed diff must not look like a healthy one.
- The transcript is not budgeted yet. A single assistant response can be as large as a diff.
