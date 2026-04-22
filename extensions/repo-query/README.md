# repo-query

Pi extension for querying code across one or more git repositories.

## Features

- **Simple interface**: pass a query and list of repos, get synthesized answers
- **Multi-repo support**: explore multiple repos for cross-reference analysis
- **Session caching**: repositories are cloned once and reused across queries
- **GitHub validation**: validates GitHub repos via API; suggests alternatives on 404
- **Archive warnings**: flags archived/deprecated repositories
- **Branch support**: specify branches via `:branch` or `@branch` suffixes
- **Shallow clones**: `--depth 1 --single-branch` for fast, disk-efficient cloning
- **Per-repo model config**: choose which LLM model explores each repository

## Usage

```
Use repo_query to investigate how React and Vue handle component lifecycle
```

The agent will call the tool with:

```json
{
  "query": "How do React and Vue handle component lifecycle? Compare patterns.",
  "repos": ["facebook/react", "vuejs/vue"]
}
```

### Repository identifier formats

| Format | Example | Notes |
|--------|---------|-------|
| GitHub shorthand | `facebook/react` | Default branch |
| With branch | `vuejs/vue:main` | Explicit branch via `:` |
| With branch | `vuejs/vue@main` | Explicit branch via `@` |
| Full URL | `https://github.com/org/repo` | Any host |
| Full URL + branch | `https://gitlab.com/org/repo@dev` | Branch suffix on URL |
| SSH URL | `git@gitlab.com:org/repo.git` | Generic git host |

### GitHub-specific behavior

- Repo not found → returns search suggestions from GitHub API
- Archived repo → warns but still explores
- Rate limited → falls back to clone attempt without validation

### Non-GitHub behavior

- No API validation (no search suggestions on failure)
- Clone failure → returns error with branch info

## Model configuration

You can configure which model the exploration subagent uses per repository.

### Config files

| Scope | Path |
|-------|------|
| Global | `~/.pi/agent/extensions/repo-query.json` |
| Project-local | `<cwd>/.pi/extensions/repo-query.json` |

Project-local overrides global. The config is a JSON file:

```json
{
  "defaultModel": "anthropic/claude-sonnet-4-20250514",
  "models": {
    "facebook/react": "openai/gpt-4o",
    "torvalds/linux": "anthropic/claude-haiku"
  }
}
```

### Resolution order

1. Per-repo config matching the first repo's display name (`owner/repo`)
2. `defaultModel` from config
3. `TEST_MODEL` environment variable
4. Subagent default (no `--model` passed)

### `TEST_MODEL` environment variable

For CI or shared workstations, set `TEST_MODEL` as a fallback:

```bash
export TEST_MODEL="anthropic/claude-sonnet-4-20250514"
```

This is used when no config file specifies a model.

### JSON schema

A JSON Schema is generated from the TypeScript config type and committed as `repo-query.schema.json`. Regenerate it after changing the config shape:

```bash
cd extensions/repo-query
bun run scripts/generate-schema.ts
```

## Install

### From repo package

```bash
pi install git:github.com/Bafbi/pi-tre
```

### One-off from local checkout

```bash
pi -e ./extensions/repo-query/src/index.ts
```

### Project-local (auto-discovered)

The `.pi/extensions/repo-query.ts` re-export is already configured for this repo.

## Dev

From repo root:

```bash
mise run check
mise run test
```

## Structure

```
extensions/repo-query/
├── src/
│   ├── index.ts       # Extension entry: tool registration + orchestration
│   ├── resolver.ts    # Repo identifier parsing
│   ├── github.ts      # GitHub API validation + search
│   ├── workspace.ts   # Session-persistent workspace management
│   ├── clone.ts       # Shallow clone logic
│   ├── explorer.ts    # Subagent spawning
│   ├── config.ts      # Config loading + model resolution
│   └── types.ts       # Shared types
├── scripts/
│   └── generate-schema.ts  # Schema generator from TypeBox
├── repo-query.schema.json  # Generated JSON Schema
└── test/
    ├── unit/          # Unit tests (github, config, clone)
    └── integration/   # Integration tests via ExtensionRunner
```

## Testing

Unit tests mock external boundaries (GitHub API via Octokit, `pi.exec` for git operations). Integration tests use `ExtensionRunner` from `@mariozechner/pi-coding-agent` to run the full extension with mocked explorers and HTTP APIs. The workspace cache is cleared between tests to avoid cross-test pollution.

### Clone behavior

`ensureRepoCloned` handles three outcomes:
- **existing** — `.git` already present in workspace (reused across session queries)
- **cloned** — shallow clone succeeded
- **failed** — all branches failed, returns error with attempted branch list

Unit tests in `test/unit/clone.test.ts` cover all three paths plus branch fallback order. Integration tests in `test/integration/extension-runner.test.ts` verify real `git clone` from a local source repo into the session workspace.
```
