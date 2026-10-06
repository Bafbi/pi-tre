# 01: Diff collector returns its omitted manifest

**What to build:** The core diff collector returns the structured omitted-file list — each path, its change count, and the reason it was dropped — beside the assembled prompt text, so a caller can persist the manifest into a Record. Today the list is rendered into a `diff-condensed` Status event and thrown away. The prompt the Sub-generator sees does not change.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] `collectDiff` returns the omitted-file list with the assembled text.
- [x] The existing `diff-condensed` Status event still fires, unchanged, when content was dropped.
- [x] The existing core diff, stamp, and fold tests pass with the new return shape.
- [x] A unit test asserts the returned list for a file over the line gate, a path matching the omit list, and a file dropped over the token budget.

## Notes

`collectDiff` returns `{ text, omitted }` (`CollectedDiff`) rather than the omitted list as a second out-parameter; callers destructure `.text` at this ticket, and `.omitted` is consumed in tickets 04 and 05.
