# 11 — Replace implementation-coupled assertions in workspace and sub-generator tests

**What to build:** Two test files assert on implementation details rather than observable behavior — they would break on innocuous refactors.

- `workspace.test.ts` `createWorkspace` tests assert on exact jj command args and call order via `exec.mock.calls[0]` / `[1]` — they test HOW (which jj subcommands, in what order) rather than WHAT (workspace exists at expected path).
- `sub-generator.test.ts` asserts on exact args array `["-p", "--no-session", "--model", "openai/gpt-4o-mini"]` — would break if pi renames `--model` to `-m`.

Replace mock-call-arg assertions with outcome-based ones. Keep the existing good assertions (returned path, directory existence, template content in stdin).

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `workspace.test.ts` `createWorkspace` tests: remove `exec.mock.calls` assertions; keep `expect(info.workspacePath).toBe(...)` and `expect(existsSync(wsRoot)).toBe(true)` assertions
- [ ] `workspace.test.ts` `createWorkspace` tests: keep the existing fallback test (verify `@` is used when `@-` fails) — but assert via outcome rather than arg inspection. Verify the workspace is created, not which specific revision string was passed
- [ ] `sub-generator.test.ts`: replace `expect(args).toEqual(["-p", "--no-session", "--model", ...])` with `expect(cmd).toBe("pi")` — assert the command, not the exact flag array
- [ ] `sub-generator.test.ts`: keep the assertions on stdin content (template rendering) — these test behavior not implementation
- [ ] All 129 tests still pass after changes
- [ ] Verify resilience: make a trivial implementation change (e.g. reorder internal helper calls) — tests should still pass

