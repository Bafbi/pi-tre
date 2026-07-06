# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it points at one `CONTEXT.md` per extension context. Read each one relevant to the topic.
- **`CONTEXT.md`** in the relevant extension directory (e.g. `extensions/repo-query/CONTEXT.md`)
- **`docs/adr/`** at the repo root for system-wide decisions, plus `extensions/<name>/docs/adr/` for per-extension decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions actually get resolved.

## File structure

Multi-context monorepo:

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions (optional)
└── extensions/
    ├── leaf-copy/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions (optional)
    ├── repo-query/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    ├── stale-write-guard/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    └── webfetch-tool/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> *Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…*
