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
│   └── types.ts       # Shared types
```
