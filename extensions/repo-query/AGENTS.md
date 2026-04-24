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
- GitHub shorthand: `owner/repo`, `owner/repo:branch`, `owner/repo@branch`
- Full URLs: `https://host.com/path`, `https://host.com/path@branch`, `https://host.com/path:branch`
- SSH URLs: `git@host.com:path.git`

Branch suffixes (`:` or `@`) are stripped before URL parsing. The colon form takes precedence.

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
- Output limit: 4000 chars truncated with ellipsis notice
- Timeout: 5 minutes

## Testing

### Test philosophy

Tests are split by concern and mock external boundaries so the suite runs fast and deterministically. Integration tests use `ExtensionRunner` from `@mariozechner/pi-coding-agent`; unit tests mock at the module boundary.

### Mock registries (globalThis-based)

Because jiti (extension loader) and native ESM (test imports) create separate module instances, in-memory caches (e.g., `cachedWorkspace`) are not shared. Test-only mock registries on `globalThis` bridge this gap:

| Registry | Key | Purpose |
|----------|-----|---------|
| `setTestExplorerImpl` | `__repoQueryExplorerMock` | Short-circuit `runExplorer` before spawning a real pi subagent |
| `setTestCloneImpl` | `__repoQueryCloneMock` | Short-circuit `ensureRepoCloned` before invoking real `git` |

Integration tests that exercise the tool end-to-end set both mocks so no external process or network is hit.

### `TEST_MODEL` environment variable

`resolveModel` falls back to `TEST_MODEL` when no config file specifies a model. This is only relevant for tests that **remove** the explorer mock and spawn a real subagent. No existing tests do this — all tests mock the explorer. If you add a test that spawns a real subagent, gate it with `describe.skipIf(!process.env.TEST_MODEL)` or document the dependency.

### Remote clone integration test

`test/integration/clone-remote.test.ts` is the only test that hits real GitHub servers. It is conditionally skipped:

- `git --version` must succeed
- `git ls-remote https://github.com/biomejs/biome.git HEAD` must succeed

The test uses `biomejs/biome` as the target repo and asserts:
- `.git/shallow` exists (confirms shallow clone)
- `package.json` exists (content sanity)
- Second call reuses the same workspace path

The test still mocks the explorer (`setTestExplorerImpl`) because subagent spawning requires a real pi process.

### Running tests

```bash
# All tests (fast + remote clone if network available)
mise run test

# Fast tests only (skip remote clone)
pnpm test -- --run --exclude="**/clone-remote.test.ts"
```
