# 01: Publish the destination bookmark with --push

**What to build:** `fold --named <branch> --push` publishes the review bookmark the Fold names, in one command, to the remotes that track it. `--update --push` keeps publishing the landing bookmark it advances. A bare `--push` with neither flag stays a usage error. This is the whole path: flag parse, usage guard, push-target selection, the push itself, the Outcome, and the tests.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] `fold --named <branch> --push` pushes `<branch>` to every remote that tracks it and reports each `bookmark` or `bookmark@remote` in the Outcome; the fold is unchanged otherwise.
- [x] `fold --named "" --push` publishes the generated `fold-<change id>` bookmark.
- [x] `fold --update [<bookmark>] --push` is unchanged: it publishes the advanced landing bookmark.
- [x] A bare `--push` with neither `--named` nor `--update` is a usage error whose message names both flags.
- [x] A failed push warns and leaves the fold successful, and the remaining remotes still get their push.
- [x] `--named --push` still records the Folded source marker, so the next fold from that source is incremental.
- [x] The push runs before `--archive` removes the session workspace.
- [x] `--push` stays opt-in; fold never pushes on its own.
- [x] `fold`'s usage and help describe `--push` as publishing the Fold's destination bookmark.
- [x] Tests cover the behavior at the Fold Action seam, the flag spec's parse and help text, and one end-to-end run against a bare remote; existing `--update --push` tests stay green.

**Deviation:** the `--update`-only push variable and `pushAdvancedBookmark` were folded into one destination-bookmark concept — `markerDestFor` resolves it at each phase (base, review bookmark and marker, push) rather than a single computed value — and the integration assertion matches `pushed review` because a first push of an untracked bookmark reports no `@remote`.
