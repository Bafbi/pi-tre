# Bound the diff content a prompt receives

**Status**: accepted

Every body-producing Action feeds a file diff to the Sub-generator. A working copy can change a generated file with a hundred thousand lines, and the diff is interpolated into the prompt verbatim, so one big file can exceed the model's context, exhaust the retry wrapper, and leave only a fallback subject.

A diff is therefore collected under a budget. `collectDiff` reads the per-file manifest (`Jj.diffFiles`), then splits it in two. A path matching `omit` keeps its name and change count and loses its content whatever its size: lockfiles, minified bundles, source maps, and vendored code are machine-generated and never useful to the generator. A file over `maxLinesPerFile` loses its content too: it is never read into memory.

There is no whole-diff read. The manifest names every file, so each kept file's section is fetched by an exact `file:"…"` fileset, only while the estimated-token budget lasts; every file after that is name-only. A dropped file contributes one marker line, so the generator still sees the path: a lockfile-only change yields `chore(deps): …`, never "no changes". The budget counts markers too, and reserves the trailing `... and N more files omitted` line up front: when a marker no longer fits, its file joins that line instead, so the assembled text stays under the ceiling. A budget too small to hold even that line drops it too.

The boundary grows one read over a `DiffSpec` (a rev, or a from/to range with filesets): `Jj.diffFiles` returns the per-file status and line count. Its path is jj's *target* path from `jj diff -T` (`path`), JSON-escaped, so a rename arrives as its new path (`new`), not the `{old => new}` display form, and a path with a newline stays one record. `Jj.diff` accepts `filesets`, so one file's section can be fetched alone.

## Considered Options

- **Condense the whole diff string (rejected).** It keeps the current one-read shape, but a monster file is materialized as a JS string before the cap runs. The budget then saves context, not memory.
- **Per-file reads (chosen).** `--stat` is cheap and never prints file content, and `jj diff -T` returns target paths that never need eliding. The pre-fetch line gate keeps a monster file out of memory. The cost is one jj read per changed file (~12 ms on jj 0.44), which is noise next to the Sub-generator call, and it removes the whole-diff read that could materialize a monster file.
- **Ship no default ignore list (rejected).** A knob nobody sets is dead. Paths are matched in the core with `matchesOmit`, and the matched files stay visible as one-line markers.

## Consequences

- The token budget is estimated as one token per four characters. The estimate is hermetic and controllable, and it bounds a prompt; it is never a billing or truncation unit.
- The per-file status and count come from two reads paired by order: `jj diff -T` gives the JSON-escaped target path and status char, `--stat` gives the count after its last `" | "`. A length mismatch is a decode failure, not a silent skip.
- `subGenerator.diff` has three knobs: `maxTokens` (12,000 estimated tokens), `maxLinesPerFile` (400), and `omit` (a default glob list). `omit: []` disables path omission.
- Dropped content emits one `diff-condensed` info status naming the omitted count. A condensed diff must not look like a healthy one.
- The transcript is not budgeted yet. A single assistant response can be as large as a diff.
