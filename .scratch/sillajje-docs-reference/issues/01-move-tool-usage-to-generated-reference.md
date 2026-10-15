# 01: Move subtool usage out of the README into a generated reference

**What to build:** the README stops carrying per-subcommand usage. It keeps the overview, what sillajje does, install, and develop. The usage blocks — the `/sillajje:<subcommand>` flag syntax and help prose — move to a generated reference whose source of truth is the code, regenerated when that code changes.

**Blocked by:** None (can start immediately)

**Status:** needs-triage

## Context

Raised during the triage of the `fold --push` destination-bookmark review. The README's Fold paragraph is a near-copy of the `CONTEXT.md` Fold entry and drifted: it kept the glossary-avoided term "advanced bookmark" after the glossary added `_Avoid_: Advanced bookmark`. A one-line fix landed as a stopgap (README now says "destination bookmark").

The durable fix is to not duplicate usage prose by hand. The per-subcommand help already lives in the code as `CommandHelp` (`FOLD_HELP` and its siblings) and renders through the shared `renderHelp`. A generator can emit the reference from those specs, so the code is the only source.

## Open questions

- The output format: a man page, a `docs/reference/` Markdown file, or both. The repo has no docs build step today.
- Where the generator lives and how it is run: a mise task, a script committed beside the extension, or a check that fails when the generated output is stale.
- Scope: every sillajje subcommand, or only the ones with non-trivial flags (`fold`, `seed`, `new`, `serve`).
- How the README points at the reference without restating it.
