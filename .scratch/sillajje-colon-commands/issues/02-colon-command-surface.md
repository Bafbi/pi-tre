# 02: Colon command surface

**What to build:** Register the six sillajje commands under the colon grammar — `sillajje:status`, `sillajje:stamp`, `sillajje:archive`, `sillajje:unarchive`, `sillajje:sync`, `sillajje:fold` — each as its own palette entry with its own description, and retire the bare `sillajje` command. Each command's handler receives the argument string without the subcommand token, so the prefix the core renders with becomes `/sillajje:`, `archive` and `unarchive` read their target from the first token, and the core's dead `skip` option and its two tests are removed. Help and usage errors name the colon form. The missing-workspace notification, the missing-workspace block reason, and the archived-session notification are updated, as are the README command section and the domain glossary's invocation lines. An ADR records the colon surface, the hard cut, and the removed bare command.

**Blocked by:** 01 (core prefix seam and handler extraction).

**Status:** done

- [x] Each of the six colon commands resolves through the extension runner and behaves exactly as the corresponding old subcommand did.
- [x] `stamp` still accepts both a Rev stamp (`-r`) and a Session stamp (`-s`) in one command.
- [x] A target-less `/sillajje:stamp` and `-h`/`--help` print that command's usage and take no action.
- [x] The old `sillajje` command no longer resolves.
- [x] `archive` and `unarchive` act on the session id given as their first argument.
- [x] Usage errors and help text read `/sillajje:<subcommand>` and no longer name `/sillajje <subcommand>`.
- [x] The core argument parser no longer accepts a `skip` option.
- [x] The missing-workspace notification, the missing-workspace block reason, and the archived-session notification instruct the user to run `/sillajje:unarchive`.
- [x] The README command section and the glossary invocation lines for Sync, Fold, the Session stamp, and the Rev stamp spell the colon form; the term "subcommand" is retained.
- [x] An ADR under the extension records the colon surface, the hard cut, the removed bare command, and why the adapter owns the prefix.

## Notes

- The `runSillajje` test helper now parses a full invocation (`"stamp -s @"`) and resolves `sillajje:<subcommand>`, so most call sites were untouched.
- Core doc comments that named `/sillajje ...` were rewritten to name the subcommand only, matching the "core spells no command" decision.
- Core argument tests now pass the `/sillajje:` prefix rather than the old space form.
