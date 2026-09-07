# AGENTS.md (local: repo-query)

## Extension purpose

Allow Pi agents to query code across external git repositories by cloning them into a sandboxed workspace and delegating exploration to a focused subagent.

## Design principles

- **Simplicity**: only two tool parameters — `query` and `repos`
- **Session persistence**: clone once, reuse across multiple queries
- **Fail-fast with help**: GitHub repos get API validation + search suggestions; others fail with clear errors
- **Safe defaults**: shallow clones, limited subagent tools, timeouts everywhere
- **Transparent**: archive/deprecation warnings are shown but don't block exploration

## Repository identifier formats

The resolver accepts:
- GitHub shorthand: `owner/repo`, `owner/repo:branch`
- Full URLs: `https://host.com/path`, `https://host.com/path:branch`
- SSH URLs: `git@host.com:path.git`

Branch suffix (`:`) is stripped before URL parsing.

## Workspace lifecycle

1. **Discovery**: check session history for previous `repo_query` tool results; reuse existing workspace path
2. **Creation**: on first call, create `/tmp/pi-rq-<session-hash>/`
3. **Clone**: shallow clone (`--depth 1 --single-branch`) into subdirectories
4. **Reuse**: subsequent queries in the same session skip existing clones
5. **Cleanup**: `session_shutdown` removes all tracked workspaces

## Subagent behavior

- Single repo: subagent cwd is the repo root
- Multiple repos: subagent cwd is the workspace parent
- Toolset: `read,grep,find,ls,bash` only (no edit/write)
- Output limit: 8000 chars truncated with ellipsis notice
- Timeout: 5 minutes

## Testing

### Test philosophy

Tests are split by concern. Unit and integration tests mock external boundaries so they run fast and deterministically, with two explicit categories: tests ending in `.service.test.ts` call real external services, and tests ending in `.llm.test.ts` make real LLM calls. Integration tests use `ExtensionRunner` from `@earendil-works/pi-coding-agent`; unit tests mock at the module boundary.

### Mocking (dependency injection)

Because jiti (extension loader) and native ESM (test imports) create separate module instances, in-memory caches (e.g., `cachedWorkspace`) are not shared.

The extension takes its seams as explicit parameters instead of global state:

- `createRepoQueryExtension({ explorer, clone })` in `src/index.ts` replaces `runExplorer` and `ensureRepoCloned` for pipeline-level `execute` tests. Tests drive the captured tool with the helpers in `test/helpers/create-runner.ts`.
- `runExplorer(options, impl)` and `ensureRepoCloned(repo, workspace, signal, pi, impl)` accept an optional last-parameter implementation for direct-call tests. `runExplorer`'s `impl` also takes a fake `spawn` and `killGraceMs` for the kill/abort paths.
- Loader-based tests (`discoverAndLoadExtensions` via `createRunner`) cannot reach factory parameters; they mock `globalThis.fetch` for GitHub validation or use local-path repos, which clone without network.

### `REPO_QUERY_MODEL` environment variable

`resolveModel` falls back to `REPO_QUERY_MODEL` when no config file specifies a model. Set it to force a model without writing a config file. Tests that need a specific model inject it through the config file or the factory overrides instead.

### Live subagent test

`test/integration/live-subagent.llm.test.ts` runs a real subagent against a local git repo and asserts the reported usage. Mise provides `PI_TEST_MODEL` by default. A provider failure (bad model, auth, quota, outage) skips the test with the provider's message instead of failing. Run `mise run //extensions/repo-query:test --no-llm` to skip it.

### Remote clone integration test

`test/integration/clone-remote.service.test.ts` is the only test that hits real GitHub servers. It runs by default through Mise, retries once, then skips with a visible reason when GitHub is unavailable. Assertion and application failures still fail the test. Run `mise run //extensions/repo-query:test --no-service` for a hermetic suite.

The test uses `biomejs/biome` as the target repo and asserts:
- `.git/shallow` exists (confirms shallow clone)
- `package.json` exists (content sanity)
- Second call reuses the same workspace path

The test mocks the explorer through the factory overrides because subagent spawning requires a real pi process.

### Running tests

```bash
# All tests, including service and LLM integration tests
mise run //extensions/repo-query:test

# Fast hermetic tests
mise run //extensions/repo-query:test --no-service --no-llm
```
