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

## Markdown model configuration

Conversion model precedence (highest to lowest):

1. CLI flag: `--webfetch-conversion-model <provider/model|model>`
2. extension config files (project overrides global):
   - `.pi/extensions/webfetch-tool.json`
   - `~/.pi/agent/extensions/webfetch-tool.json`
3. env var: `PI_WEBFETCH_CONVERSION_MODEL`
4. Pi default model selection

## HTML preprocessor configuration

Preprocessor precedence (highest to lowest):

1. CLI flag: `--webfetch-html-preprocessor <regex|dom>`
2. extension config files (project overrides global):
   - `.pi/extensions/webfetch-tool.json`
   - `~/.pi/agent/extensions/webfetch-tool.json`
3. env var: `PI_WEBFETCH_HTML_PREPROCESSOR`
4. default: `regex`

Example config file:

```json
{
  "$schema": "../../extensions/webfetch-tool/webfetch-tool.config.schema.json",
  "conversionModel": "anthropic/claude-sonnet-4-5",
  "htmlPreprocessor": "dom"
}
```

Schema file:
- `extensions/webfetch-tool/webfetch-tool.config.schema.json`

If your Pi setup has the same model ID under multiple providers, use `provider/model` to avoid ambiguous selection (for example `openrouter/gpt-4o` instead of `gpt-4o`).

## Debugging

Use:

```text
/webfetch-debug [on|off|status|toggle|dump]
```

- `on/off/toggle`: control debug status + widget
- `status`: show whether debug is enabled
- `dump`: write a full diagnostic report into the editor

## Notes

- Only `http`/`https` URLs are allowed.
- Localhost/private IP targets are blocked.
- Redirects are followed manually and validated per hop.
- HTML is preprocessed before sub-agent conversion to reduce boilerplate and token load (`main/article/content` extraction + script/style/nav/footer removal).
- `dom` preprocessing uses `parse5`; `regex` remains available as the default.
