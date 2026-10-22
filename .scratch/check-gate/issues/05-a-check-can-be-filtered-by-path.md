# 05: A check can be filtered by path

**What to build:** A repository whose check is one monolithic command — a plain test runner with no notion of changed modules — can scope that check to the paths it covers. When the interaction's diff touches nothing that matches, the check does not run, and the record says it was skipped rather than passed.

**Blocked by:** 01.

**Status:** done

- [x] A check accepts a `paths` list of globs.
- [x] The filter is matched against the interaction's diff, before the command runs, so a skipped check costs nothing.
- [x] No match records the check as `skipped`, in both the Record and the `Checks:` line. A skipped check never appears as passed.
- [x] A check with no `paths` always runs.
- [x] A gate whose every check is skipped reports nothing ran, and renders no `Checks:` section.
- [x] Tests: matching and non-matching paths, a check with no filter, and the all-skipped gate, through the integration harness and the core seam.

**Deviation:** No deviation.
