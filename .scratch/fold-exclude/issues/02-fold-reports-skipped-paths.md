# 02: The fold records and reports the paths it skipped

**Spec:** `.scratch/fold-exclude/PRD.md`

**What to build:** A Fold that excluded paths names them in the folded change's Commit body, so a reviewer who runs `jj show` sees what the Fold left behind. The line is absent on an ordinary Fold that excluded nothing, and `actions.fold.body` decides whether it renders. The session also reports the exclusion as an info status while the Fold runs. The README describes the flag and the body default.

**Blocked by:** 01.

**Status:** done

Note: the `Skipped:` section renders inline (`Skipped: .scratch/, *.lock`) rather than as a multi-line body, matching `Ref:` and `Meta:`; the ticket did not pin the shape. The committed config schema was regenerated.

- [ ] The fold body vocabulary gains a `skipped` section, and the default body order is summary, ref, skipped.
- [ ] The `Skipped:` line renders only when the Fold excluded at least one path, and names those paths.
- [ ] A Fold without `--exclude` keeps today's body shape, with no `Skipped:` line.
- [ ] `actions.fold.body` can leave the `skipped` section out, and the line disappears.
- [ ] A Fold that excludes paths emits an info status naming them.
- [ ] The body assembler seam is covered by a test: the section renders when paths are present, is omitted when they are not, and follows a configured body that leaves it out.
- [ ] The README's fold usage line and its `actions.fold.body` default row describe the flag and the section.

## Done

- The fold body vocabulary gains `skipped`, default order `["summary","ref","skipped"]`.
- `Skipped:` renders inline when paths are present, is omitted when not, and follows a configured body that leaves it out.
- The Fold emits a `fold_excluded` info status naming the paths, and the adapter renders it as a notification.
- The README usage line, body sentence, and `actions.fold.body` row are updated; the JSON config schema is regenerated.
