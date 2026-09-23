# Each Action owns its body sections and its provenance

**Status**: accepted

An Action contributes named sections, not a shared provenance record. `stamp` contributes `Meta:` — the `Source`, the ids it touched, the model, the fallbacks, and the versions — and, on an Interaction stamp, `Loop:`. `fold` contributes `Summary:` and `Ref:`. `sync` contributes no body. `actions.<action>.body` selects the sections and their order. There is no `Action` union and no `action:` field: the section is the action's name. This supersedes the `action` / `source` split named in ADR 0005 and the `trigger` it replaced.

## Considered Options

- **A shared `Provenance { action, source, ... }` (rejected).** `sync` renders no body, so it would carry a provenance it never emits, and `action` restates the section label.
- **A discriminated union per action (rejected).** It reintroduces a union over actions and still has no `sync` variant.
- **Each action owns its sections (chosen).** The section seam already says each action declares what it contributes, so each action also declares the facts those sections carry.

## Consequences

- `Source` is stamp-local: `interaction`, `diff`, or `rev`. Fold's provenance is its `Ref:` range.
- The old `trigger` is deleted. `manual-session` becomes a stamp with `source: diff`; `interaction` becomes a stamp with `source: interaction`; `rev` becomes a stamp with `source: rev`.
- Config moves from `message.*` to `actions.<action>.*`: an ordered `body` section list plus per-section detail (`header.mode`, `trace.detail`, `loop` field list, `summary.detail`). Presence in `body` replaces `enabled`. The change is breaking, with no migration shim.
- `assembleBody(subject, sections)` becomes `assembleDescription(subject, sections)`. The Commit body is the sections; the Commit description is the subject plus the body.
