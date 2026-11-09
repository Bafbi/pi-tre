# web-search

Searches the live web through the OpenCode Console, one tool, billed per search.

## Language

**Spend gate**:
The `enabled` config key. The tool runs only when the gate is open, so the default install spends nothing. The gate is
read on every call, not at load.
_Avoid_: Feature flag, toggle, enablement

**Console search**:
One billed request to `POST {endpoint}` with `providerID: "opencode"`. It costs USD 0.01 and returns ranked results.
_Avoid_: Query, lookup, fetch
