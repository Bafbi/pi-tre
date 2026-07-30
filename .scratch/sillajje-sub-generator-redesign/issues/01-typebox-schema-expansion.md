# 01 — Extend TypeBox schema with message and subGenerator trees

**What to build:** The `SillajjeConfigSchema` TypeBox schema (in `config.ts`) grows with two new configuration trees — `message` (controlling the commit body structure) and `subGenerator` (controlling retry and timeout behavior). All new fields are optional and apply sensible defaults via TypeBox `Default()`. Existing config files without these keys continue to work unchanged. Unit tests verify that partial configs fill in defaults correctly and that individual meta fields are independently toggleable.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] TypeBox schema extended with `message` tree:
  - `message.header`: `Type.Union([Type.Literal("one_line"), Type.Literal("user_prompt")])` with default `"one_line"`
  - `message.body.trace`: object with `enabled` (boolean, default `true`) and `detail` (union of `"high"`, `"step"`, `"decision"`, default `"high"`)
  - `message.body.meta`: object with `enabled` (boolean, default `true`), `tools` (boolean, default `true`), `call_count` (boolean, default `true`), `elapsed` (boolean, default `true`), `thinking_blocks` (boolean, default `true`)
  - `message.body.user_prompt`: boolean, default `true`
  - `message.body.response`: boolean, default `true`
- [ ] TypeBox schema extended with `subGenerator` tree:
  - `subGenerator.retry.maxAttempts`: integer, default `3`
  - `subGenerator.timeoutMs`: integer, default `30_000`
- [ ] `SillajjeConfig` TypeScript type updated (derived from schema via `Static`)
- [ ] `DEFAULTS` constant updated (automatically via `Default()`)
- [ ] Unit tests: missing `message` key → all body sections enabled with defaults
- [ ] Unit tests: missing `subGenerator` key → retry defaults to 3, timeout to 30000
- [ ] Unit tests: individual meta fields toggleable (`meta.tools: false` → tools field disabled, rest enabled)
- [ ] Unit tests: `message.header: "user_prompt"` accepted
- [ ] Unit tests: backward compatibility — config with only `{ debug: true }` loads with all new defaults
- [ ] Unit tests: `trace.detail` validates against literal union (rejects invalid values)
- [ ] Run `generate-schema` script to update JSON Schema file
