# 01: Prefactor — core prefix seam and handler extraction

**What to build:** Two behaviour-preserving refactors that make the colon surface a registration-only change. First, the core stops spelling any slash command: the usage line becomes subcommand-relative, the argument parser and help renderer take the command prefix as an argument, and the adapter passes the current `/sillajje ` spelling so every help and usage error reads exactly as it does today. Second, each branch of the adapter's subcommand switch becomes a named handler over the same argument string and context, still dispatched by the single `/sillajje` command. No user-visible change.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] `@pi-tre/sillajje-core` no longer contains the string `/sillajje` in any usage line, help text, or parser message.
- [x] The argument parser and help renderer accept a prefix; the rendered output with the current prefix is byte-for-byte the existing output.
- [x] Every existing core argument test and adapter integration test passes unchanged in intent.
- [x] Each of the six subcommands is a named handler, and the single `/sillajje` command still dispatches all six with no behaviour change.
- [x] No new test seam is introduced.

## Notes

- Handlers are typed with `ExtensionCommandContext`, not the adapter's narrow `CommandContext`, because they read `ctx.cwd` and pass the context to `syncPill`.
- The per-extension `check` does not format; ran `mise run format` before it.
