# 04: Warn at Archive, re-seed at Unarchive

**What to build:** Archive warns, naming the seeded paths whose Workspace copy diverged from the Seed record, before it deletes the Workspace, so an unpushed edit is not lost silently. Unarchive re-copies the seed list from the source root recorded in the Seed record, so a restored session has the same local files it started with.

**Blocked by:** 02.

**Status:** done

- [ ] Archive names each seeded path whose Workspace copy differs from the Seed record, warns, and then proceeds to delete the Workspace.
- [ ] Archive never pushes a seeded path to the checkout.
- [ ] Unarchive re-copies the seed list from the source root recorded in the Seed record, after it rebuilds the Workspace.
- [ ] When the recorded source root is gone, Unarchive copies from the current checkout root and warns that it did.
- [ ] Tests cover the above at the extension integration seam.

## Comments

Built: Unarchive re-copies the config's `seed` list (not the record's file
list), using the Seed record only for the source root; a fallback re-seed
writes a new record with the current root as its source. Archive resolves the
target to read its record, so a foreign session's Archive warns from its own
log.
