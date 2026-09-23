# The command surface uses pi's colon grammar

Sillajje's subcommands are registered as six commands — `sillajje:status`, `sillajje:stamp`, `sillajje:archive`, `sillajje:unarchive`, `sillajje:sync`, `sillajje:fold` — not as one `/sillajje` command with hand-split arguments. Pi matches the whole token before the first space and lists one palette entry per invocation name, so the colon form gives each Action its own description, help, and completion slot, and reuses the grammar pi already uses for `skill:<name>` and its own duplicate-name suffixes (`review:1`). The bare `/sillajje` command is removed rather than aliased, and an input guard corrects anyone who types the old space form.

The command prefix moves to the adapter: `@pi-tre/sillajje-core` renders a subcommand-relative usage line and takes the prefix (`/sillajje:`) as an argument, so the pi-free core no longer spells a pi command.

## Considered Options

**Colon grammar (chosen)** vs hyphens (`sillajje-stamp`) vs one command with a dispatch switch. Hyphens match no pi convention; the single command hides each Action from the palette and from argument completion.

**Hard cut (chosen)** vs keeping `/sillajje <subcommand>` as an alias. An alias doubles the surface forever to serve muscle memory; this is a local tool with one user, and the guard turns the one failure mode — the stale text reaching the model — into a correction.

**Remove the bare command (chosen)** vs keeping `/sillajje` as a discovery hub. The guard already covers the migration, and a seventh command whose only job is to list six others is surface with no behavior.

## Consequences

- `/sillajje stamp` and bare `/sillajje` match no command, so the adapter catches them on the input event, names the colon form, and returns `handled`. An unknown colon subcommand falls through to pi's normal behavior.
- The core's `skip` option is gone: each command receives only its own arguments, so no subcommand token needs dropping.
- If the extension is loaded twice, pi names the commands `sillajje:stamp:1` and `sillajje:stamp:2`.
- Extension commands cannot carry an `argumentHint`; the description is the only palette text an extension controls. Per-command `getArgumentCompletions` is deferred.
