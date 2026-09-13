# Redesign sub-generator: dual parallel calls, dual-prefix taxonomy, configurable body

> 2026-09 update: the transport changed. The two calls now run in-process through `@pi-tre/pi-subagent`'s in-process backend instead of spawning `pi -p` child processes; the dual-call design, taxonomy, and body structure below are unchanged. See `docs/adr/0001-subagent-isolation.md` at the repo root.

The original sub-generator was a single `pi -p` call producing a conventional-commit subject and summary. It had three problems: (1) conventional-commit prefixes assume file changes and don't describe interaction-only sessions, (2) the model struggled to produce a useful summary when asked to do both classification and narration in one output, (3) the body structure was hardcoded with no per-section toggles.

We redesigned it into two focused sub-generator calls running in parallel — one for the dual-prefix subject line (header), one for the compressed agent-loop narrative (trace) — with a configurable body structure.

## Considered Options

**Path A (chosen): dual parallel in-process calls.** Two tool-less pi subagents run through `@pi-tre/pi-subagent`'s in-process backend, each with a focused prompt (header classification vs. trace narration). No tools — the model only generates text. Full parallelism since inputs are identical. Configurable body sections gated by `message.body.*` in the sillajje config. Costs: double the model calls per interaction, but at `gpt-4o-mini` prices this is negligible.

**Path B (rejected): single call with two named outputs.** One `pi -p` call producing both header and trace, delimited by markers. Rejected because: (1) the model is asked to do two different cognitive tasks in one pass, (2) parallel calls are faster end-to-end than a sequential single call, (3) focused prompts produce better output than a combined prompt.

**Path C (rejected): direct LLM API call instead of pi.** Bypasses pi entirely for lower latency. Rejected because: it requires separate API key management, breaks the unified model config surface (`subGeneratorModel`), and the latency win is marginal for a background task.

## Consequences

- Each interaction runs up to two in-process sub-generator calls in parallel. If either is disabled by config, only the enabled one runs.
- The dual-prefix taxonomy (`act`, `plan`, `explore`, `research`, `ask`, `answer`, `debug`) captures interaction type at a glance, independent of whether files changed.
- The trace replaces the old "Summary" with a compressed agent-loop narrative at configurable detail levels (`high` / `step` / `decision`).
- Body sections (trace, meta, user prompt, response) are individually toggleable. Existing configs without `message` keys get the full default structure — backward compatible.
- Retry: 3 total attempts per sub-generator call, retrying on session failure and empty output. Header falls back to `deriveSubject(prompt)`; trace falls back to empty string.
