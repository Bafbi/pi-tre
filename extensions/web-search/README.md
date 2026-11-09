# web-search

Adds one pi tool, `search_web`, that searches the live web through the OpenCode Console.

Each successful search costs **USD 0.01**, billed to your OpenCode workspace balance. The tool ships off. Nothing is
spent until you enable it.

## How to enable the tool

1. Copy the keys you want into `~/.pi/agent/configs/web-search.json`.

```json
{
	"$schema": "./web-search.schema.json",
	"enabled": true
}
```

For one project instead of every project, write the same file to `<repo>/.pi/configs/web-search.json`. The project
layer applies only when the project is trusted, and it wins over the global layer per key.

2. Start pi. The model now sees `search_web` and calls it through codemode.

To turn the spend off again, set `"enabled": false` or delete the key.

## How to configure it

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Turn the tool on. Every successful search costs USD 0.01. |
| `maxResults` | `8` | Results kept per search, 1 to 20. |
| `timeoutMs` | `25000` | Request timeout in milliseconds, 1000 to 120000. |
| `credentialProvider` | `"opencode-go"` | pi provider whose key authorizes the Console. `"opencode"` also works. |
| `endpoint` | `"https://opencode.ai/console/api/websearch"` | Console endpoint. Change it only for a different Console host. |

Every key is optional. The loader merges the global and project layers and fills the defaults. A file with an
out-of-range value is ignored as a whole, with a warning, so a typo leaves the spend off rather than half-applied.

## How the tool answers

A call returns:

```text
# Web search: opencode web search pricing

8 results. Billed USD 0.01 to the OpenCode workspace balance.

1. Web search
   https://opencode.ai/docs/console/websearch/
   OpenCode can search the web. The first search asks you to ...
```

The result also carries `structuredContent` for codemode scripts: `status`, `query`, `provider`, `endpoint`,
`costUsd`, `error`, and `results[]` with `url`, `title`, `content`, and `published`.

`status` is one of:

- `ok`: the search ran and was billed.
- `disabled`: the config gate is shut. Nothing was billed and no request was made.
- `unconfigured`: no OpenCode credential was found. Nothing was billed.
- `failed`: the Console call failed. Nothing was billed.

A successful call also reports `usage.cost.total` as `0.01`, so the spend appears in pi's session totals.

## How to fix a failing search

| Message | Fix |
| --- | --- |
| `OpenCode rejected the API key (HTTP 401)` | Sign in again with `/login opencode-go`, or set `OPENCODE_API_KEY`. |
| `The OpenCode workspace balance is exhausted (HTTP 402)` | Add credit in the OpenCode console. |
| `OpenCode rate limited the search (HTTP 429)` | Wait, then search again. |
| `search_web has no OpenCode credential` | Sign in with `/login opencode-go`, or set `OPENCODE_API_KEY`. |
| `the answer stays the same until that file changes` | Set `"enabled": true` in the config file the message names. |

## How to develop it

```bash
mise run //extensions/web-search:check    # lint, typecheck, hermetic tests
mise run //extensions/web-search:ci       # check, type-aware scan, non-hermetic tests
mise run //extensions/web-search:generate-schema
```

The hermetic tests never reach the network: the Console client unit tests inject a `fetch` stub, and the tool tests
inject both a `fetch` stub and a key resolver.
