# Checks config schema

Type: grilling
Status: resolved
Blocked by: —

## Question

What does a check declaration look like in sillajje config, and what does the schema let a repo say?

Settled going in: checks are declared, not discovered, and each check carries its own triggers (`settle`, `publish`, `manual`). The schema lives in `packages/sillajje-core/src/config.ts`, next to `SillajjeConfigSchema`, because the core owns the schema and the adapter only loads it.

Open sub-questions:

- **Command form.** A string run through a shell, or an argv array run without one? A string buys `mise run check 2>&1 | tail`; an argv array buys no quoting bugs. Which does the config accept, or both?
- **Reference vs command.** Does a check name a `mise` task, or an arbitrary command? A task reference binds sillajje to mise; an arbitrary command keeps it repo-agnostic.
- **Fields.** Which of these are per check: `name`, `command`, `triggers`, `timeoutMs`, `cwd`, `env`, an output cap, `stopOnFailure`, `enabled`? Which are defaults at the `checks` level instead?
- **Default trigger.** A check that names no trigger: does it run on `settle` (safe default, more cost) or on nothing (must be asked for)?
- **Ordering and short-circuit.** Do checks run in declared order, and does the first failure stop the rest? A `lint` failure makes `test` pointless; a `test` failure tells you more than `lint` did.
- **Gate sets.** Is "the fast set runs on settle, the full set runs on publish" expressed only through triggers, or is there a second axis (a `gate: fast | full` field)? One axis is simpler; two axes let a repo run a slow check on settle too.
- **Empty config.** No `checks` key means no checks at all, and the extension behaves exactly as today. Confirm that is the intended default rather than a built-in `mise run check`.
- **Schema generation.** `scripts/generate-schema.ts` emits `sillajje-config.schema.json`; the new fields must land there and in `.pi/configs/sillajje.json`'s `$schema` reference.

## Answer

Decided with the user.

**Value calls.**

- A check that names no `triggers` defaults to `settle`. A declared check that silently never runs erodes trust in the gate; the full suite is declared with `publish` instead, and ticket 06 measures what the default costs.
- A gate runs every check it selects and reports every failure. The retry budget is one shot, so a partial report costs a whole extra interaction. This repo's `mise run check` already runs lint, typecheck, and tests together.

**The shape.** A top-level `checks` array of objects. Every field but `name` and `command` has a default, so the short form stays short.

```json
"checks": [
  { "name": "check", "command": "mise run check" },
  { "name": "ci", "command": "mise run ci", "triggers": ["publish"], "timeoutMs": 600000 }
]
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | string, required, unique | — | The check's identity: in status events, Records, the `Checks:` section, and the report to the agent |
| `command` | string, required | — | A shell command line, run with `sh -c` |
| `triggers` | array of `settle` \| `publish`, unique | `["settle"]` | Where the check runs automatically. `[]` means on demand only |
| `timeoutMs` | integer | `300000` | The field exists here; what a timeout does is ticket 07 |

One sibling key: `checks.maxAttempts`, default 5, the gate's attempt budget. Its policy is settled in [Feedback to the agent](02-feedback-to-the-agent.md).

**Amended by [Manual check entry point](09-manual-check-entry-point.md).** There is no `manual` trigger value. A Trigger is `settle` or `publish`; a Check with `triggers: []` runs only when asked for through `/sillajje:check`, which is what a `manual` value would have meant. One concept, not two.

**Mechanism decisions, with why.**

- `command` is a shell string, run with `sh -c` and `cwd` set to the workspace root. This is exactly `postInit` (`extensions/sillajje/src/index.ts:513`): the same `sh -c`, the same trust story, the same inline justification for the repo's `no-shell-c` ast-grep rule. An argv form would be a second trust story for the same job.
- `checks` is a top-level key, not `actions.check`. `seed`, `postInit`, and `vcsGuard` are already top-level non-action keys; `actions.<action>` exists for body-producing actions with `body`/`header`/`trace` settings, and a check produces no body of its own.
- One selector axis: `triggers`. A second `gate: fast | full` field would let a slow check opt into `settle` while claiming to be full.
- No `enabled` field. To stop a check running, delete it or set `triggers: []`; an empty array means on demand only, not disabled.
- No `cwd` field. Always the workspace root. `mise run //extensions/<name>:check` resolves from the root anyway.
- No `env` field. Inherit the process environment. A filtered env is ticket 05's argument if it survives.
- No per-check `stopOnFailure`. Running every check is gate policy, not check config.
- Absent or empty `checks` means no checks and the extension behaves exactly as it does today. There is no built-in `mise run check`; the repo names its own gate.

**Unblocks.** 05 (trust and workspace safety) and 07 (long check execution), both of which needed the field set to argue about.

**Implementation constraints for the ticket that builds this.** `packages/sillajje-core/src/config.ts` gains the schema, `scripts/generate-schema.ts` regenerates `sillajje-config.schema.json`, and this repo's `.pi/configs/sillajje.json` gains the two checks above. `triggers` must reject an unknown value at load rather than fall through to the default, and two checks must not share a `name`.
