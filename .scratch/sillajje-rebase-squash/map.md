## Destination

Two new `/sillajje` subcommands — `rebase` and `squash` — that integrate a session's work with an upstream revision (`<rev>`, usually `main`). Both share a rebase+update-stale preamble. `rebase` stops there (session @ becomes a merge of `<rev>` + session bookmark). `squash` continues: creates a single squashed commit on `<rev>`, stamps a conventional-commit message via sub-generator, then archives the session.

## Notes

- Domain: sillajje extension (`extensions/sillajje/`)
- Skills: none beyond sillajje's existing patterns (command handler switch, workspace module, sub-generator)
- `--session` defaults to current session; resolves other sessions via `getWorkspacePathByName`
- Conflicts detected via non-zero exit of `jj rebase` → abort + notify

## Decisions so far

<!-- populated as tickets resolve -->

## Not yet specified

<!-- nothing — the way is clear -->

## Out of scope

<!-- nothing -->
