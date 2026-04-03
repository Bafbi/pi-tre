# webfetch-tool

Pi extension that adds a `webfetch` tool.

## What it does

1. Fetches a URL with `curl`
2. Runs prompt-injection scoring (semgrep-like regex rules + fuzzy rules)
3. Applies a safety decision (`allow`, `allow_with_warning`, `block`)
4. Converts content to markdown using a constrained sub-agent
5. Falls back to a deterministic converter if sub-agent conversion fails

## Tool parameters

- `url` (required)
- `mode` = `safe_markdown` | `raw_markdown` | `extract_only`
- `strictSafety` (default `true`)
- `maxBytes` (default `400000`)
- `timeoutSec` (default `25`)
- `maxRedirects` (default `3`)
- `maxMarkdownChars` (default `30000`)

## Notes

- Only `http`/`https` URLs are allowed.
- Localhost/private IP targets are blocked.
- Redirects are followed manually and validated per hop.
- No external npm dependencies are used for scoring/conversion logic.
