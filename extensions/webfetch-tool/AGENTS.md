# AGENTS.md (local: webfetch-tool)

## Extension purpose
Provide a safe `webfetch` tool for Pi:
- fetch web content using curl
- detect prompt injection with deterministic local rules
- convert content to markdown via a constrained sub-agent

## Design principles
- Safety-first URL and content policy checks
- Deterministic scanning and scoring (no model dependency)
- Explicit phase reporting for debuggability
- Fallback behavior when sub-agent conversion fails

## Structure expectations
- `src/index.ts`: tool wiring + orchestration
- `src/fetch.ts`: curl execution + redirect handling
- `src/url-policy.ts`: URL policy and private-host guards
- `src/scan.ts`: semgrep-like + fuzzy scoring
- `src/subagent.ts`: constrained sub-agent conversion
- `src/markdown.ts`: deterministic fallback converter
