# 03: Move edits both ways with `--push` and `--pull`

**What to build:** `/sillajje:seed --push` copies Workspace edits to the source checkout, and `--pull` refreshes the Workspace copy from the checkout. Each direction refuses a path the other side changed since the seed, names the path, and lets `--force` override the refusal. Neither direction ever deletes a file on the other side.

**Blocked by:** 02.

**Status:** done

- [ ] `--push` copies each seeded path whose Workspace copy differs from the Seed record back to the source checkout.
- [ ] `--pull` refreshes each seeded path in the Workspace from the source checkout.
- [ ] `--push` refuses a path whose checkout copy also moved since the seed; `--pull` refuses a path whose Workspace copy moved since the seed. Each refusal names the path.
- [ ] `--force` overrides a refusal and completes the write, used with `--push` or `--pull`.
- [ ] `--push` and `--pull` are mutually exclusive, and `--force` requires one of them.
- [ ] A path present on one side and missing on the other is reported and is never deleted on the other side.
- [ ] A non-`@` target is rejected; Seed acts only on this session.
- [ ] The Outcome names every moved, refused, and missing path.
- [ ] Tests cover the above at the extension integration seam.

## Comments

Built: a successful move appends a new Seed record, advancing the baseline, so
a second `--push` is not a false conflict, and the baseline also advances when
both sides converge on the same content. Seed is current-session-only, so the
record is always this session's and no foreign log is written. A missing source
is reported and the other side is never deleted; a missing destination is
created from the source when the source exists.
