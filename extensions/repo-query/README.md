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

### Result contract

The model sees formatted text. Code-mode scripts receive `structuredContent`:

```ts
{
  status: "ok" | "partial" | "failed",
  query: string,
  model: string | null,
  answer: {
    text: string,
    complete: boolean,
    findings: Array<{
      repo: string | null,
      path: string,
      line: number | null,
      claim: string,
      verified: boolean
    }>
  } | null,
  repos: Array<{
    identifier: string,
    displayName: string,
    branch: string | null,
    status: "success" | "archived" | "not_found" | "clone_failed" | "exploration_failed" | "skipped",
    localPath: string | null,
    warnings: string[],
    error: string | null,
    suggestedRepos: string[],
    suggestedBranches: string[]
  }>,
  usage: {
    input: number,
    output: number,
    totalTokens: number,
    cost: number,
    costFromProvider: boolean
  } | null,
  tempspacePath: string
}
```

`status` is `ok` when every repository answered, `partial` when some failed, and `failed` when none answered or the exploration failed. A failed call returns `isError: true` with the same structure, so a script can read `repos[].error`, `repos[].suggestedRepos`, and `repos[].suggestedBranches` without parsing prose.

The subagent ends its answer with a fenced `json` block of claims. The tool parses it, removes the block from the text, and checks each finding against the clone. `verified` is true when the path exists and the line is within the file. A malformed block falls back to the prose answer with no findings.

### One call or several

A batch is one query over several repositories. Use it to compare repositories, or to use them together, such as a documentation repository beside the code repository it documents. The subagent answers across all repositories, and the clones run in sequence.

For the same question across unrelated repositories, call once per repository from a code-mode script and combine the results with `Promise.allSettled`. Clones run in parallel, each answer is attributed to its repository, and a per-repo model override applies. Keep a fan-out to five calls or fewer.

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
  },
  "explorer": "process"
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

### Exploration backend

`explorer` selects how the exploration runs.

| Value | Behavior |
|-------|----------|
| `process` (default) | Spawn a child pi process with the tool allowlist. |
| `auto` | Use T3 Code's `delegate_task` when it is registered. Otherwise spawn a child pi process. |

Set `explorer` to `auto` to use the delegate. It is opt-in because a T3 delegate is a broader agent than the child process.

Under T3 Code, the delegate is a T3 thread, so the exploration appears in the UI. The delegate reads the tempspace clone by absolute path because its working directory is the T3 project.

The delegate runs with full access. T3 has no per-delegate tool allowlist, and `approval-required` asks for every codemode or bash call, which makes exploration unusable. The task prompt restricts codemode to `read`, `grep`, `find`, and `ls` and forbids `bash`, `edit`, `write`, and `repo_query`.

The delegate title starts with `read-only:`. T3 sets the child session name to that title. A `tool_call` hook in this extension checks `ctx.sessionManager.getSessionName()` and allows only `read`, `grep`, `find`, `ls`, `codemode`, and `tool_search` in that session. Everything else is blocked, including `write`, `edit`, `bash`, `powershell`, `repo_query`, and T3 control tools. pi applies the same hook to nested codemode calls, so `tools.write` inside a script is blocked. This covers pi delegates. A delegate on another provider does not load this extension and is not covered.

The project `.pi/settings.json` adds `+grep`, `+find`, and `+ls` so codemode exposes those read-only tools.

If T3 rejects full access or the delegate fails, repo_query falls back to the child process. A delegate that waits or times out is cancelled first.

The child pi process keeps a strict tool allowlist: `read`, `grep`, `find`, `ls`, and `bash`.

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
