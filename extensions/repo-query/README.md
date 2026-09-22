# repo-query

Pi extension for querying code across one or more git repositories.

## Features

- **Simple interface**: pass a query and list of repos, get synthesized answers
- **Multi-repo support**: explore multiple repos for cross-reference analysis
- **Session caching**: repositories are cloned once and reused across queries
- **GitHub validation**: validates GitHub repos via API; suggests alternatives on 404
- **Archive warnings**: flags archived/deprecated repositories
- **Branch support**: specify branches via `:branch` suffix
- **Shallow clones**: `--depth 1 --single-branch` for fast, disk-efficient cloning
- **Per-repo model config**: choose which LLM model explores each repository

## Usage

```text
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
| Full URL | `https://github.com/org/repo` | Any host |
| Full URL + branch | `https://gitlab.com/org/repo:dev` | Branch suffix on URL |
| SSH URL | `git@gitlab.com:org/repo.git` | Generic git host |

### GitHub-specific behavior

- Repo not found → returns search suggestions from GitHub API
- Archived repo → warns but still explores
- Rate limited → falls back to clone attempt without validation

### Non-GitHub behavior

- No API validation (no search suggestions on failure)
- Clone failure → returns error with branch info

### Branch failure suggestions

When cloning an explicit branch fails, the extension runs `git ls-remote --heads` to fetch the remote's branch list and uses **fuzzy matching** (Levenshtein distance) to suggest up to 5 similar branch names. Examples:

| Requested | Suggested |
|-----------|-----------|
| `mian` | `main` |
| `develp` | `develop` |
| `Master` | `master` |
| `featurefoo` | `feature/foo` |

If similar branches are found, the error message includes: `Did you mean one of these branches: main, main-v2?`

## Model configuration

You can configure which model the exploration subagent uses per repository.

### Config files

| Scope | Path |
|-------|------|
| Global | `~/.pi/agent/configs/repo-query.json` |
| Project | `<cwd>/.pi/configs/repo-query.json` |

The project config wins per key and is read only when pi trusts the project. The config is a JSON file:

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
3. `REPO_QUERY_MODEL` environment variable
4. Subagent default (no `--model` passed)

### `REPO_QUERY_MODEL` environment variable

To force a model without writing a config file, set `REPO_QUERY_MODEL`:

```bash
export REPO_QUERY_MODEL="anthropic/claude-sonnet-4-20250514"
```

This is used when no config file specifies a model.

### JSON schema

A JSON Schema is generated from the TypeScript config type and committed as `repo-query.schema.json`. Regenerate it after changing the config shape:

```bash
mise run //extensions/repo-query:generate-schema
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

### Auto-discovered in this repo

The root `package.json` lists the extension under `pi.extensions`, so pi loads it for this repo.

## Dev

From repo root:

```bash
mise run check
mise run test
```

## Testing

Unit tests mock external boundaries (GitHub API via Octokit, `pi.exec` for git operations). Integration tests use `ExtensionRunner` from `@mariozechner/pi-coding-agent` to run the full extension with mocked explorers and HTTP APIs. The tempspace cache is cleared between tests to avoid cross-test pollution.

### Clone behavior

`ensureRepoCloned` handles three outcomes:
- **reused** — a valid clone already present at the clone target (reused across session queries)
- **cloned** — shallow clone succeeded
- **failed** — all branches failed, returns error with attempted branch list

When a branch-specific clone fails, the function runs `git ls-remote --heads` to gather available remote branches, then uses **fuzzy matching** (normalized Levenshtein similarity ≥ 0.4) to suggest up to 5 similar branch names in the error message.

Unit tests in `test/unit/clone.test.ts` cover all three paths plus branch suggestions. Integration tests in `test/integration/extension-runner.test.ts` verify real `git clone` from a local source repo into the session tempspace.

## Tests

Run the suite from the extension directory or via mise:

```bash
mise run //extensions/repo-query:check
```

The default suite is hermetic. Tests that call real services use the
`.service.test.ts` suffix, and tests that call a real LLM use the
`.llm.test.ts` suffix. Both are excluded from the default run. Run them
explicitly:

```bash
mise run //extensions/repo-query:test-external   # service and LLM only
mise run //:test-all                             # hermetic and external
```

A live subagent test (`test/integration/live-subagent.llm.test.ts`) runs a real
LLM against a local repo. Mise provides `PI_TEST_MODEL` by default. Override it
in `mise.local.toml` or your shell. Provider failures skip with a visible
reason. The GitHub service test retries once, then skips with a visible reason
when GitHub is unavailable. Assertion and application failures still fail the
test.
