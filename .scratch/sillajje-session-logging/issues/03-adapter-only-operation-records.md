# 03: Records for the remaining adapter-only operations

**What to build:** Records for the operations the adapter already drives without a core change: `guard` (a blocked tool call and a corrected old command form), `seed` (copy at session start, and `/sillajje:seed` push and pull), `base` (`/sillajje:new` resolving the Base), `sync`, and `archive` / `unarchive` including the shutdown auto-archive. Each writes a start and a terminal Record, carries the input and the outcome, and names its trigger so a command and an automatic path are distinguishable.

**Blocked by:** 02 (the Record type and write seam).

**Status:** done

- [x] `guard` records a blocked tool call and a corrected command form, and routine path redirects stay unrecorded.
- [x] `seed` records the direction (copy / push / pull) and the paths touched.
- [x] `base` records the resolved Base and its label.
- [x] `sync` records the target, the resulting rev, and any conflict files.
- [x] `archive` and `unarchive` record their outcome, and the `trigger` separates the command from the shutdown auto-archive.
- [x] Each operation has a test at the extension integration harness seam that reads the Record off the branch.

## Notes

Guard writes its start and terminal Records synchronously (two `writeRecord` calls) because it is an instantaneous decision, not an async run. Tests: guards (old form + absolute path) and Seed and Archive live in `record.test.ts`; Sync, Base, and Unarchive assertions were added to the existing `sync`, `new-session`, and `archive` integration tests to avoid duplicating their jj setup. The shutdown auto-archive Record is wired but has no dedicated test.
