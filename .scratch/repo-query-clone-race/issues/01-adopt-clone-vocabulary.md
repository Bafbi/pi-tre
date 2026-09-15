# 01: Adopt the clone vocabulary

**What to build:** The extension uses one name for each concept, end to end. The per-session temp root becomes the Tempspace, the directory a repository identifier resolves to becomes the Clone target, and the clone outcome carries a reason. The persisted tool-result details field is renamed to the tempspace spelling, and reading session history accepts both the old and new key so sessions recorded before the rename still reuse their tempspace instead of cloning again. No clone behavior changes.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Code, types, and tool-result details use tempspace and clone target vocabulary; the old `workspace` naming is gone for this concept.
- [x] The clone outcome status is renamed from `existing` to `reused`.
- [x] `ensureRepoCloned`'s `workspace` parameter and the temp-root type names use the tempspace spelling.
- [x] `extensions/repo-query/AGENTS.md` uses the tempspace vocabulary.
- [x] A session history entry recorded under the old details key still resolves the existing tempspace.
- [x] Existing clone, tempspace, and integration tests pass with unchanged behavior.
- [x] The extension check passes.

## Notes

- Also renamed `runExplorer`'s `tempspace` option, `DebugState.tempspacePath`/`setTempspacePath`, the render label, README, and the module and test files (`workspace.ts`/`workspace.test.ts` → `tempspace.ts`/`tempspace.test.ts`), beyond the explicit list.
