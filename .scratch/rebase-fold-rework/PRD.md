# PRD: Rebase and fold rework

Status: needs-triage

## Problem

Rebase and fold landed before the two-layer stamp feature. They share one preamble, but they never adopted the seams that feature added:

- Their jj mutations call `pi.exec` directly, so the test seam cannot inject failures into them.
- Fold hand-rolls the diff-only header and the describe step that `stampRev` now owns.
- Parsing and the three-state error message are duplicated between the two subcommands and stamp.
- Fold's mutation is a sequence of separate jj operations, so a mid-sequence failure leaves partial state.

This document is the rework backlog. It absorbs `.scratch/stamp-two-layer/issues/06-fold-on-stamp-seam.md`.

## Rework items

### 1. Route rebase and fold jj calls through the exec seam

`setTestExecWrapper` (`extensions/sillajje/src/index.ts`) wraps the `ExecFn` returned by `resolveExecFn` and its doc says every jj call passes through it. The rebase and fold paths bypass it with direct `pi.exec("jj", ...)` calls:

- rebase: `index.ts` lines 963 (`jj rebase`), 994 (`jj resolve --list`), 1015 (`jj workspace update-stale`).
- fold: lines 1480 and 1522 (`jj log children(<rev>)`), 1507 (`jj new <rev> --no-edit`), 1549 (`jj abandon`), 1563 (`jj restore`), 1579 (`jj diff -r <foldId>`), 1602 (`jj describe`).

Target: replace those calls with the resolved `exec` adapter. `exec` delegates to `pi.exec` when no wrapper is installed, so production behavior is unchanged and the seam covers both subcommands. Then the seam doc's "every jj call" claim is true.

### 2. Describe the folded change through `stampRev`

Fold generates its own subject and describes its own change (`index.ts` lines 1594 to 1613): `generateManualHeader(diff, resolveSpawnFn(), ...)` then `jj describe -r <foldId> -m <subject>`. This duplicates `stampRev` and misses its provenance `Meta:` block, its `header-fallback` status, and its error taxonomy.

Target: call `stampRev({ wsPath, rev: foldId }, deps)` for the describe step. Decide whether fold needs its own provenance trigger; `StampTrigger` is currently `"interaction" | "manual-session" | "rev"` (`src/metadata.ts`).

### 3. Make fold transactional

Fold sequences `jj new <rev> --no-edit` → `jj restore --from @ --to <foldId>` → `jj describe` → workspace cleanup. Each step is an integrated jj operation. On failure it abandons the empty change it created, but a failure after `jj restore` leaves content copied without a description, and a failure before the abandon leaves the empty change on `<rev>`.

The stamp seal solved the same problem with the deferred-integrate transaction in `sealWorkingCopy` (`src/stamp/internal.ts`). That runner is private to the stamp module.

Target: either extract the transaction runner into a shared module and run fold's steps inside it, or keep separate steps and document the partial states with explicit cleanup. The first is the reliability win the stamp feature already paid for.

### 4. Share one argument parser

`parseStampArgs` (`src/stamp-args.ts`) and `parseRebaseFoldArgs` (`src/rebase-fold.ts`) duplicate the tokenize-and-loop shape with divergent rules. Stamp takes flags only, errors on a valueless flag, rejects positionals, and supports `-h`. Rebase and fold take a positional `<rev>` and ignore a trailing `--session` with no value.

Target: one tokenizer and rule set shared by all three subcommands. Keep stamp flag-only and rebase/fold positional. Add `-h`/`--help` to rebase and fold at the same time (see item 6).

### 5. Share the three-state session error renderer

The `not-a-session` and `archived` messages are built by the same ternary in the rebase/fold preamble (`index.ts` around line 946) and in the stamp `-s` branch. `resolveSessionTarget` is already shared; only the rendering is not.

Target: one helper, for example `sessionTargetErrorMessage(reason, sessionKey)`, called from both.

### 6. Add `-h`/`--help` to rebase and fold

Stamp prints help for `-h`, `--help`, and a target-less invocation. Rebase and fold only print a usage warning when `<rev>` is missing (`index.ts` around line 903).

Target: match the stamp command shape and reuse the shared parser from item 4.

### 7. Name the folded change from the transaction, not a before/after diff

Fold identifies the change created on `<rev>` by diffing `children(<rev>)` before and after `jj new` (`index.ts` lines 1480 to 1541). The comment explains why: parsing `jj new`'s output is fragile, and `<rev>+` is ambiguous when other descendants exist.

Target: once a shared transaction runner exists (item 3), have it return the change or operation it created, and delete the two `jj log` queries and the abandon fallback.

### 8. Retire `generateManualHeader`

After item 2, `generateManualHeader` (`src/sub-generator.ts`) has no caller in fold. Check for any other caller and delete the function and its tests.

## Out of scope

- The current-session exemption in `resolveSessionTarget` stays. It is documented in the resolver and in the `Session target` glossary entry after the PR #9 triage. Rebase and fold inherit it by design.
- Rebase and fold keep the positional `<rev>` flag style. Only stamp uses the flag form for its target.
