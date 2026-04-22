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
- Full URLs: `https://host.com/path`, `https://host.com/path@branch`
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

## Implementation constraints

- Keep GitHub API calls minimal (validate once per repo per session)
- Support `GITHUB_TOKEN` env var for higher rate limits
- Clone with branch fallback: explicit → `main` → `master`
- Always cleanup temp prompt files even on failure
- Store workspace path in tool result `details` for session reconstruction
