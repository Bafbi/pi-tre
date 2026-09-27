# Fold: key the `--update` base to the review branch

Status: ready-for-agent

## Problem Statement

`--update <bookmark>` only appends when the same source published the previous fold. The base record is a `sillajje/folded/<source>/<target>` bookmark, where `<source>` is the session key for a session source, or the source bookmark/rev for a `-r` source. A session that hands its work to a new session (`/sillajje:new -s @`) gets a new session key, so `--update <branch>` finds no marker and falls back to the fork point. The fork point sits before the work already folded into the branch, so fold re-aggregates and replays history the branch already holds instead of appending only the new work. The key also grows one bookmark per session per branch, and no reader ever consumes the extra half.

## Solution

The recorded base belongs to the review branch, not to the source. `--update <bookmark>` looks up one marker keyed by the bookmark alone: `sillajje/folded/<target>`. Any source that continues the branch's history — the same session, a handed-off session, or a rev — appends only its new work. Fold still falls back to the fork point with the existing `fold_update_fallback` info when no marker exists, and now also when the recorded tip is not an ancestor of the current tip. Legacy `<source>/<target>` markers are left in place and ignored; the first `--update` after upgrade whole-folds once, then continues incrementally.

## User Stories

1. As a pi session user, I want `--update <bookmark>` to find the recorded base even when a different session published the previous fold, so that continuing work appends instead of replaying from the fork point.
2. As a pi session user, I want a session created with `/sillajje:new -s @` to append only its own new work when it folds `--update <branch>`, so that a handed-off session produces one clean incremental change.
3. As a pi session user, I want to hand work from one session to another and keep folding the same review branch, so that a long-running PR branch grows across session lifetimes.
4. As a user folding a rev source, I want the base keyed by the review branch, so that a continuation from a renamed or different rev still appends.
5. As a user, I want exactly one marker bookmark per review branch, so that refs do not accumulate one per session per branch.
6. As a user, I want an unrelated source folding into a branch to fall back to the fork point with an info status, so that a wrong base never silently produces a bad delta.
7. As a user, I want `--update` to fall back when the recorded tip is not an ancestor of the current tip, so that a rebase or divergent rewrite cannot corrupt the published change.
8. As a user, I want a source rebased by `/sillajje:sync` to keep its recorded base, so that update keeps appending after a rewrite.
9. As a user, I want a divergent or abandoned source rewrite to be caught by the ancestor check, so that a conflicted marker never becomes a bad base.
10. As a user upgrading sillajje, I want legacy `<source>/<target>` markers ignored without error, so that the upgrade needs no cleanup step.
11. As a user upgrading sillajje, I want the first `--update` after upgrade to whole-fold once and then continue incrementally, so that migration is a one-time non-event.
12. As a user, I want no new flags and no config, so that the fix changes nothing about how I invoke fold.
13. As a user, I want `-o <rev> --named <branch>` to seed the same marker that `--update <branch>` reads, so that publish-then-update works from any source.
14. As a user, I want `-o <rev>` without `--named` to seed the marker under the target's local bookmark, so that a later `--update <bookmark>` appends.
15. As a user, I want the fold commit body unchanged, with `Ref:` as its provenance, so that published changes carry no new session metadata.
16. As a user, I want the marker to stay a jj bookmark, so that jj moves it when the source commit is rewritten.
17. As a user, I want `--update` to keep its exclusivity with `-o`, `--land`, and `--named`, so that the existing usage rules still hold.
18. As a user, I want the missing-marker and non-ancestor cases to report the same `fold_update_fallback` info, so that the status vocabulary stays small.
19. As a maintainer, I want the marker key and base resolution pinned at the fold Action port seam, so that the shape is tested without a real repository.
20. As a maintainer, I want the handoff and guard verified at the pi command seam against real jj, so that the end-to-end behavior is proven.
21. As a maintainer, I want the now-unused source-name resolution removed, so that the fold Action carries no dead code.

## Implementation Decisions

- The marker key becomes `sillajje/folded/<target>`. `<target>` stays the review branch: `--update`'s argument; `-o`'s `--named` name; otherwise the target's single local bookmark, otherwise a slug of the target rev.
- The marker value is unchanged: the source tip. For a session source that is the last seal (the session bookmark), never the workspace working copy `@`. For a rev source it is the resolved rev.
- The `--update` read path builds `sillajje/folded/<target>`, finds the local bookmark, and uses it as the base only when it resolves to one commit and that commit is an ancestor of the current tip. Otherwise it bases on `fork_point(tip | target)` and emits the `fold_update_fallback` info.
- The ancestor check adds no new port method: it uses the existing jj log seam with one revset that is non-empty exactly when the recorded commit is an ancestor of the tip (`recorded::tip`).
- Both write paths (`--update` and `-o`) set `sillajje/folded/<target>` inside the existing fold transaction, at the source tip.
- The source-name resolution — `FoldSource`'s `name` and the helper that derives it from the tip's local bookmark or a rev slug — is removed. The marker key was its only reader.
- No migration, no cleanup, no new flags or config. Legacy `sillajje/folded/<source>/<target>` markers stay unread and in place.
- Fold's provenance stays its `Ref:` range. No session identity is added; the earlier request for fold to name its source session is dropped.
- Modules: the `sillajje-core` fold Action. Glossary: the `extensions/sillajje/CONTEXT.md` "Folded source" entry is rewritten and ADR 0006 gains an amendment.

## Testing Decisions

- A good test asserts external behavior: which files land on the review branch, which marker bookmark exists, and which status is emitted. It does not assert internal call order or private helpers.
- Primary seam, the highest one: the pi command surface. The fold integration suite drives `fold ... --update ...` through the adapter against a real jj repository with a canned sub-generator, then asserts the branch's files and the marker bookmark. Prior art: "appends only the new commits when --update targets the review branch", "keeps a separate marker per review branch", "a plain fold ignores the Folded source marker and re-aggregates from the fork point".
- Secondary seam: the fold Action over fake ports. The core unit suite builds the Action with a fake jj port and asserts the mutation recipe (marker name, duplicate revset) and the status stream. Prior art: "uses the Folded source marker as the base and advances the review bookmark with --update", "--update falls back to the fork point with no marker", "--named sets a review bookmark and keys the marker by it".
- New cases at the command seam: a handoff append where a second source whose tip descends from the recorded tip publishes only its new work; the branch-only marker name after a fold; a non-ancestor recorded tip that falls back and reports `fold_update_fallback`.
- New cases at the port seam: the marker name is branch-only for both `--update` and `--named`; the Folded source marker is ignored when the ancestor check fails; a legacy two-part key is not read.
- Integration tests stay hermetic: real jj subprocess, canned sub-generator, no network.

## Out of Scope

- Migrating, adopting, or deleting legacy `sillajje/folded/<source>/<target>` markers.
- A marker cleanup or gc command.
- Session identity, or any new fold-body section.
- `--exclude`, `--rebase`, and the other deferred fold ideas.
- Publish-mode semantics beyond the marker key; `-o` still only seeds the marker and does not advance the target without `--land`.
- Extracting the sillajje commands into a CLI.

## Further Notes

- jj moves a local bookmark onto its rewritten commit on a single-successor rewrite (`MutableRepo::update_local_bookmarks`). Keeping the marker a bookmark therefore carries it across `/sillajje:sync` and other rebases with no extra code. A divergent rewrite leaves a conflicted bookmark and an abandon moves it to the parent; both fail the ancestor check and fall back.
- The branch key change removes the last place the session or source name lived in the fold marker.
- This is the second key migration in this area. ADR 0006 already recorded the first and its one-time whole-fold, so this follows established precedent.
