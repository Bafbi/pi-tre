# Extension config lives in `.pi/configs/<extension>.json`

Every extension reads one config file per layer: `<repo-root>/.pi/configs/<extension>.json` for the project and `~/.pi/agent/configs/<extension>.json` for the global layer. One shared module, `@pi-tre/pi-config`, resolves both paths with `CONFIG_DIR_NAME` and `getAgentDir()`, deep-merges global then project with the project winning per leaf, strips unknown keys with a warning, applies schema defaults, and returns a fully-populated object. repo-query and sillajje had drifted into different paths and different merge rules, and the divergence was the bug the convention removes.

Extensions gate the project layer behind `ctx.isProjectTrusted()`. Project config can carry shell commands (sillajje's `postInit`), so an untrusted project gets the global layer only.

## Considered Options

**One shared loader in `packages/pi-config`, following `packages/pi-subagent` (chosen).** Divergence was the observed failure, so one implementation is the fix.

**Per-extension loaders (rejected).** Each extension keeps its own paths and merge rules. This is the state that produced the problem.

**pi's own example paths (rejected).** pi's examples disagree: `preset` uses `~/.pi/agent/presets.json` and `.pi/presets.json`, while `sandbox` uses `~/.pi/agent/extensions/sandbox.json` and `.pi/sandbox.json`. Following either scatters loose JSON at the `.pi/` root or collides with extension code discovery under `.pi/extensions/`. A dedicated `.pi/configs/` namespace keeps one file per extension and no collision.

**Hardcoding `.pi` and `~/.pi` (rejected).** sillajje hardcoded both, which ignores `CONFIG_DIR_NAME` and `PI_CODING_AGENT_DIR`. A rebranded distribution or a relocated agent dir would lose the config silently.

**Whole-file precedence for the project layer (rejected).** sillajje let the project file replace the global file entirely. A project that sets one key would drop every global setting, which is the wrong default for a schema this deep.

**Reject the whole file or strip silently on unknown keys (rejected).** repo-query dropped every valid setting over one unknown key. sillajje dropped the key with no notice. A silently ignored typo (`defaultmodel` for `defaultModel`) reads as a config that does nothing. The loader strips the key and warns.

## Consequences

- The `dotagents` repo owns `~/.pi/agent/configs/` and deploys it to every host as a symlink into `~/.agents/pi/configs`. Edit the global config in the dotagents repo, not on the host.
- An untrusted project's config is ignored. Sillajje's `postInit` no longer runs from an untrusted repo.
- Any extension that reads configuration depends on `@pi-tre/pi-config`. leaf-copy and stale-write-guard read none today.
- Environment overrides stay per extension. `REPO_QUERY_MODEL` and `SILLAJJE_POST_INIT` are extension policy, not loader policy.
- The term "project-local config" is retired in favor of "project config".
