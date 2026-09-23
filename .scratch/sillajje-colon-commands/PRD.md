# PRD: Colon command surface for sillajje

Status: ready-for-agent

## Problem Statement

Every sillajje capability hides behind one `/sillajje <subcommand>` command whose arguments are split by hand. Pi cannot offer per-command completion or per-command help for a surface it cannot see, so `status`, `stamp`, `archive`, `unarchive`, `sync`, and `fold` are indistinguishable in the command palette and invisible to argument autocomplete. The pi-free core also spells a pi slash command inside its usage lines, so a package that promises never to import pi still knows the adapter's command name.

## Solution

Register six commands that Pi namespaces with the colon grammar it already uses for `skill:<name>` and its own duplicate suffixes: `/sillajje:status`, `/sillajje:stamp`, `/sillajje:archive`, `/sillajje:unarchive`, `/sillajje:sync`, and `/sillajje:fold`. Each appears as its own palette entry. The bare `/sillajje` command is removed, and a guard on user input tells anyone who types the old space form which colon command to use instead of sending the stale text to the model. The usage line moves out of the core: the core renders the subcommand-relative tail, and the adapter supplies the `/sillajje:` prefix.

## User Stories

1. As a Pi user in a sillajje repo, I want `/sillajje:stamp` to seal the current session's working copy, so that I do not have to remember that stamp is the second word of a longer command.
2. As a Pi user, I want `/sillajje:status` to report the session lifecycle, repo root, session id, and workspace, so that I can see where my work lives.
3. As a Pi user, I want `/sillajje:archive` to retire the current session's workspace, so that I can free the directory without losing the session bookmark.
4. As a Pi user, I want `/sillajje:unarchive <session-id>` to rebuild an archived session's workspace, so that I can resume work I set aside.
5. As a Pi user, I want `/sillajje:sync -o <rev>` to bring a revision into a session's ancestry, so that I can reconcile with upstream without losing the session's own history.
6. As a Pi user, I want `/sillajje:fold -o <rev>` to publish a source range as one clean change, so that a review branch grows without a force-push.
7. As a Pi user, I want a Session stamp on another live session (`/sillajje:stamp -s <id>`), so that I can seal a sibling session from this conversation.
8. As a Pi user, I want a Rev stamp on any revision (`/sillajje:stamp -r <rev>`), so that I can describe a single change without sealing my own.
9. As a Pi user, I want `/sillajje:stamp -h`, `/sillajje:sync -h`, and `/sillajje:fold -h` to print that subcommand's usage, so that I can learn one command without reading the others.
10. As a Pi user, I want a target-less `/sillajje:stamp` to print usage and seal nothing, so that an accidental invocation is harmless.
11. As a Pi user, I want the six commands to appear separately in the slash-command palette, so that I can discover them by name.
12. As a Pi user, I want each palette entry to carry a description, so that I can tell `:sync` from `:fold` before invoking.
13. As a Pi user, I want to type `/sillajje stamp` out of habit and be told to use `/sillajje:stamp`, so that my prompt is not sent to the model by mistake.
14. As a Pi user, I want `/sillajje:unarchive` to be left alone by the old-form guard, so that a valid command is never misreported.
15. As a Pi user, I want a mistyped colon subcommand such as `/sillajje:nope` to behave like any unknown command, so that the guard stays narrow.
16. As a Pi user, I want the missing-workspace and archived-session messages to name the new commands, so that the instruction I am told to follow actually works.
17. As a Pi user, I want the README command section to describe the colon surface, so that the documentation matches what I type.
18. As a maintainer, I want `@pi-tre/sillajje-core` to render a subcommand-relative usage line and take the command prefix as an argument, so that the core no longer names a pi command.
19. As a maintainer, I want the adapter to own the `/sillajje:` prefix, so that a second adapter can name the same actions differently.
20. As a maintainer, I want the dead `skip` option removed from the core argument parser, so that no caller passes a subcommand token that no longer exists.
21. As a maintainer, I want an ADR recording the colon surface, the hard cut, and the removed bare command, so that a future reader does not reintroduce an alias.
22. As a maintainer, I want the existing integration and core test seams reused, so that the rename adds no new injection points.
23. As a maintainer, I want the extension's domain glossary to spell the new invocations, so that Sync, Fold, and the stamp variants stay consistent with the code.

## Implementation Decisions

- **Six commands, colon grammar.** The adapter registers `sillajje:status`, `sillajje:stamp`, `sillajje:archive`, `sillajje:unarchive`, `sillajje:sync`, and `sillajje:fold`. `stamp` keeps both the Rev stamp (`-r`) and the Session stamp (`-s`) in one command; the flags already separate them.
- **Hard cut.** The old `/sillajje <subcommand>` form is not aliased and the bare `/sillajje` command is removed. This is a local tool with one user; a permanent alias would double the surface for no gain.
- **Old-form guard.** The adapter's existing `input` handler matches `/^\/sillajje(\s|$)/`, notifies the correct colon form, and returns `handled` so the text never reaches the model. An unknown colon subcommand falls through to Pi's normal behavior.
- **Surface-only scope.** `status`, `archive`, and `unarchive` keep splitting their own arguments; they are not ported to `CommandSpec`. The core's `skip` option loses its only production caller and is removed along with its two tests.
- **The core owns the grammar, the adapter owns the spelling.** `CommandSpec.usage` and `CommandHelp.usage` become the relative tail (for example `stamp [-r|--rev <rev>] [-s|--session <id>]`). `parseCommandArgs` and `renderHelp` take the prefix as an argument, and the adapter passes `/sillajje:`. Usage errors and help render as `${prefix}${usage}`. This removes the pi spelling from `@pi-tre/sillajje-core`.
- **Positional shift.** `archive` and `unarchive` read their target from the first argument token, since the subcommand token is no longer part of the argument string.
- **In-code instructions updated.** The missing-workspace notification, the missing-workspace block reason given to the agent, and the archived-session notification name `/sillajje:unarchive`.
- **Documentation updated in the same slice.** The README command section and the `CONTEXT.md` invocation lines for Sync, Fold, the Session stamp, and the Rev stamp spell the colon form. The glossary term "subcommand" is kept for the token after the colon.
- **ADR.** A new ADR under the extension records the colon surface, the hard cut, the removed bare command, and the adapter-owned prefix.
- **No version bump, no changelog.** There is no changelog convention for this extension to extend; the ADR is the record.

## Testing Decisions

A good test asserts external behavior: the notification a command emits, the state it changes, and the exit it returns. It does not assert which internal branch dispatched it or the shape of the dispatch table. A rename must not change any command's behavior, so the existing assertions on notifications and side effects are the contract.

- **Adapter command seam (existing).** Resolve each command through the extension runner by its invocation name and call its handler with an argument string and a command context. This is the highest seam and the one the current integration tests already use. It covers all six commands, the `archive`/`unarchive` positional shift, the absence of the old `sillajje` command, the colon-form help text, and the missing-workspace messages.
- **Adapter input seam (existing).** Emit an `input` event with the old form and assert the correction notification and the `handled` action, then emit a colon command and assert the guard does not fire. This is where the current archived-session and steering tests live.
- **Core argument seam (existing).** Call the argument parser and the help renderer directly with a prefix and assert the rendered usage line, the removal of `skip`, and the relative usage constants. This is where the current usage-string assertions live.

No new seams are introduced. The adapter's test-injection hook for the sub-generator and the jj exec function is untouched.

## Out of Scope

- Argument autocomplete (`getArgumentCompletions`) for flag names, session ids, or revisions. Pi replaces the whole argument string on completion, so this needs a full-line reconstruction and, for ids and revs, a jj read. Deferred.
- Porting `status`, `archive`, and `unarchive` onto `CommandSpec`.
- Any further de-pi-ification of the core beyond the prefix seam.
- Version bump and changelog.
- Any change to the Action interfaces in `@pi-tre/sillajje-core`.

## Further Notes

- Pi matches the whole token before the first space, so `/sillajje:stamp` resolves to a command registered under that literal name.
- Extension commands run before skill-command expansion, so a skill named `sillajje` cannot shadow them.
- Pi assigns `:<n>` suffixes when two extensions register the same name; two copies of this extension would appear as `sillajje:stamp:1` and `sillajje:stamp:2`.
- Extension commands cannot carry an `argumentHint`; only built-in commands can. The description is the only palette text an extension controls.
