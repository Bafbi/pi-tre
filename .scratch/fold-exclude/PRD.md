# `fold --exclude`: leave named paths out of the published change

Status: ready-for-agent

## Problem Statement

When I fold a session's work, the folded change carries everything the session touched, including `.scratch/` issue tickets and other local noise. The tickets have to stay in the session log, because a handoff session (`/sillajje:new -s @`) continues from the previous session's seal and needs that history. That rules out `.gitignore`: ignoring `.scratch/` would drop the tickets from the session log as well. So I have no way to publish the real work without also publishing the tickets, and a reviewer of the landed change sees tickets that were never meant to ship.

## Solution

`fold` accepts a repeatable `--exclude <path>` in both modes, `-o <rev>` publish and `--update <bookmark>`. Each value names a path prefix or glob; the Fold publishes the delta of everything else. The excluded paths stay in the source and in the session log, so the handoff still carries them. The folded change's Commit body gains a `Skipped:` line naming them, and the fold reports the exclusion as an info status. Exclusion is permanent for that review branch: the Folded source marker still records the source tip, so a later `--update` does not publish the excluded paths either. A fold whose delta only touched excluded paths returns the existing `no-changes` no-op.

## User Stories

1. As a Pi user landing a session, I want to exclude `.scratch/` from a Fold, so that the published change carries my work and not my issue tickets.
2. As a Pi user, I want to exclude a directory by prefix, so that every file under it stays out without my listing each one.
3. As a Pi user, I want to exclude a glob such as `*.lock`, so that generated files stay out of the published change.
4. As a Pi user, I want to repeat `--exclude` with several paths, so that one Fold can leave out more than one kind of noise.
5. As a Pi user, I want `--exclude` in `-o` publish mode, so that a whole source delta publishes without the excluded paths.
6. As a Pi user, I want `--exclude` in `--update` mode, so that new work appends to a review branch without the excluded paths.
7. As a Pi user, I want the excluded paths to remain in the source branch, so that the session's own history keeps the tickets.
8. As a Pi user, I want the excluded paths to remain in the session log, so that a handoff session inherits the complete trail.
9. As a Pi user, I want the next `--update` to base on the folded source tip, so that excluded paths are not published on the next fold either.
10. As a Pi user, I want the Folded source marker to keep its current shape, so that existing review branches keep working with no migration.
11. As a Pi user, I want a `Skipped:` line in the folded change's body, so that `jj show` tells a reviewer what the Fold left behind.
12. As a Pi user, I want the `Skipped:` line omitted when a Fold excluded nothing, so that ordinary folds keep their current body.
13. As a Pi user, I want the generated Summary built from the included paths alone, so that the body never describes a file the change does not carry.
14. As a Pi user, I want an info status at fold time naming the excluded paths, so that I see the exclusion as it happens.
15. As a Pi user, I want a fold that only touched excluded paths to return `no-changes`, so that I never get an empty folded change.
16. As a Pi user, I want an all-excluded delta to report `no-changes` before any mutation, so that a mistaken exclusion costs nothing.
17. As a Pi user, I want `--exclude` combined with `--land`, so that I can advance the target bookmark while leaving noise out.
18. As a Pi user, I want `--exclude` combined with `--named`, so that a named review branch excludes paths.
19. As a Pi user, I want `--exclude` combined with `--push`, so that the pushed bookmark holds only the included work.
20. As a Pi user, I want `--exclude` combined with `--archive`, so that a fold can publish, exclude noise, and retire the session in one command.
21. As a Pi user, I want `--exclude` to be per invocation, so that a Fold I run without the flag publishes everything.
22. As a Pi user, I want the help text to document `--exclude`, so that I discover the flag from the command itself.
23. As a Pi user, I want a clear usage error when `--exclude` has no value, so that a typo never silently changes what I publish.
24. As a Pi user, I want paths relative to the workspace the Fold reads, so that `.scratch/` means the repository's `.scratch/`.
25. As a Pi user, I want the flag to work for a rev source as well as a session source, so that excluding paths is not tied to sessions.
26. As a Pi user, I want the fold to roll back completely when a conflict appears, so that a conflicting exclusion leaves no partial state.
27. As a maintainer, I want the exclusion to reach jj as a fileset, so that path matching follows jj's own rules instead of a second implementation.
28. As a maintainer, I want the excluded set to stay out of the marker, so that no new bookmark shape appears.
29. As a maintainer, I want the `Skipped:` section controlled by `actions.fold.body`, so that the body contract stays configurable.
30. As a maintainer, I want a repeated non-repeatable flag to keep its current last-wins behavior, so that adding repeatable flags changes no existing command.

## Implementation Decisions

- The Fold Action's input gains repeated exclude values. The Action compiles them into one jj fileset: the union of the patterns, complemented. A value is a workspace-relative path prefix or glob, compiled to a `prefix-glob` pattern. Fileset syntax stays internal to the Action.
- The `squash` Mutation gains an optional fileset list. The boundary appends the filesets as positional arguments to `jj squash`.
- A new `abandon` Mutation carries one revset. The boundary builds `jj abandon <revset>`.
- The transaction recipe keeps duplicating the whole delta, because `jj duplicate` takes no fileset. The change is at the squash and after it:
	1. `new` an empty child of the target, as today.
	2. `duplicate` the delta `base..tip` onto the target, as today.
	3. `squash` the duplicated range into the folded change with the included fileset.
	4. `abandon` the duplicated range, because a partial squash does not empty the copies.
	5. `conflicts` on the folded change, then the bookmark writes, as today.
	Without a fileset the recipe is unchanged: step 4 is redundant and the unfiltered squash abandons the copies by emptying them. This sequence came from a prototype against `jj 0.44.0`; it confirmed that a partial squash leaves the excluded paths in the copies, so the copies need the explicit abandon.
- The included-fileset diff drives both the generated Summary and the empty-delta check. When the delta range is non-empty but the included diff is empty, the Fold returns `no-changes` before any mutation.
- The Folded source marker is unchanged: it records the source tip. The consequence is that excluded paths never publish from that review branch, which is the intended permanent semantics.
- The fold body vocabulary gains a `skipped` section. The default body is `["summary","ref","skipped"]`. The section renders only when the Fold excluded at least one path, which matches how the body assembler omits empty sections.
- The command spec declares `--exclude` as repeatable with a required value, in both modes. No exclusivity is added: `--exclude` combines with `--land`, `--named`, `--push`, and `--archive`.
- `FlagDef` gains a repeatable marker. The parser collects repeated values into an ordered list for such flags and keeps the current last-wins behavior for the rest.
- The Action emits an info status naming the excluded paths.

## Testing Decisions

A good test here asserts external behavior at an existing seam: the observable result, the status stream, and the command line the boundary builds. It does not reach into the Action's internals or assert helper calls.

The primary seam is the Fold Action, driven with fake ports and the recording sink. It is the highest seam, and it covers the behavior end to end: exclusion values become one fileset, the encoded fileset reaches the squash, the Summary and the `no-changes` check use the included diff, the `Skipped:` section carries the paths, and the marker still records the source tip in both modes. Prior art is the existing fold Action test.

Three lower seams move because the decisions live there, one test each:

- The shared arg parser: a repeatable flag collects its values in order, a repeated non-repeatable flag stays last-wins, and a repeatable flag missing its value errors. Prior art is the existing arg parser test.
- The jj boundary argv: a `squash` with filesets appends them as positionals, and the new `abandon` mutation builds its revset argv. Prior art is the existing argv test and the mutation tests.
- The body assembler: the `skipped` section renders when paths are present, is omitted when empty, and follows a configured body that leaves it out. Prior art is the existing body test.

One integration test against real jj drives the registered command, as the existing fold integration test does. It proves the mechanism with a real repository: a Fold excluding a directory leaves that directory out of the folded change's tree while the source keeps it, and a fold whose delta only touched the excluded paths returns `no-changes`.

Every test is hermetic. The sub-generator is mocked, as in the existing integration tests, so no test needs a model.

## Out of Scope

- Sticky exclusion: a branch-persistent excluded set or a config default.
- Deferred exclusion: publishing excluded paths on a later fold.
- Excluding revisions or revsets from the delta.
- Exclusion on `stamp`, `sync`, or `archive`.
- Cosmetic exclusion that changes the Summary but not the published tree.
- `.gitignore` changes.
- Migrating existing review branches; the marker shape does not change, so none is needed.
- Re-publishing paths that an earlier Fold already left out.

## Further Notes

- ADR 0006's amendment records this decision and supersedes its earlier "`--exclude` is deferred" consequence.
- The glossary carries two new terms, Excluded paths and Skipped section, and the Fold and Commit body entries name the flag.
- Known limitation: an exclude pattern that matches nothing is a no-op, and the Fold renders no `Skipped:` line. A typo therefore publishes everything. Detecting the miss would need a file-list comparison per pattern, which is not worth the cost now.
- The README's fold usage line and its `actions.fold.body` default row change with the implementation, not before it.
