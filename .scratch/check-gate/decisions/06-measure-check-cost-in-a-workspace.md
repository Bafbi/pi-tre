# Measure check cost in a session workspace

Type: task
Status: resolved
Blocked by: —

## Question

Nothing to decide. The numbers are needed before the trigger model can be argued honestly: if `mise run check` takes four minutes in a fresh workspace, running it on every interaction is not a design, it is a stall.

Work, AFK:

1. Create a session workspace for this repo the way sillajje does, or reuse an existing one under `~/.pi/sillajje/pi-tre/`.
2. Run the `postInit` steps (`mise trust`, `mise deps`) and record how long the first install takes.
3. Run `mise run check` cold. Record wall time and whether it passes with no extra setup.
4. Run `mise run check` again warm, with no source change. Record wall time and confirm the per-module skip fires.
5. Touch one file in `extensions/sillajje` and run `mise run check` again. Record wall time — this is the realistic per-interaction cost.
6. Try `mise run ci` once and record whether it completes, and how long it takes.

Report: a table of the numbers, whether a workspace needs setup beyond `postInit` before checks can run, and whether anything fails for environmental reasons (missing tool, missing lockfile, network).

## Answer

Run in the session workspace `/home/neudeline/.pi/sillajje/pi-tre/01a15379-6431-72d0-ae80-ce0d644ccbbe`, mise 2026.10.11, jj 0.46.0, node 25.9.0.

The workspace already had `node_modules` (304M) and a recorded `mise trust`, so `postInit` had run. A genuinely cold install was not measured: it needs a fresh jj workspace, and `jj workspace add` is a VCS command this session was not authorised to run.

| Run | Wall time | Result |
|---|---|---|
| First `mise run check` in a workspace with no task cache | 135s | exit 1 — flaky |
| Second `mise run check` (nothing cached, because mise caches only successes) | 118s | exit 0 |
| Third `mise run check`, nothing changed | 5.6s | exit 0 — every module task skipped |
| `mise run check` after touching `extensions/sillajje` + `packages/sillajje-core` | 119s | exit 0 — 21 module tasks skipped, 2 modules re-ran |
| `mise //extensions/sillajje:check` after a touch | 111s | exit 0 — lint 0.46s, typecheck 0.85s, tests 110s (348 tests) |
| `mise //packages/sillajje-core:check` after a touch | 4.4s | exit 0 — 298 tests in 3.7s |
| `mise run ci` | 135s | exit 1 — red at `//:type-aware` |
| `pnpm run type-aware` alone | 68s | exit 1 — 6 warnings |

**What the numbers say.**

- The cost is almost entirely the test suites: sillajje's 348 integration tests take 110s, sillajje-core's 298 take 3.7s. Lint and typecheck together are 1.3s per module. The root-only tasks (format, lint, typecheck:strict, typecheck:tests, ast-grep, knip, config-roots, boundaries) cost 5.6s even when every module skips.
- `mise run check` is not a viable settle gate as configured in [Checks config schema](01-checks-config-schema.md): a settle would stall the interaction for about two minutes, and this repo's most-edited module is the slow one.
- A red run poisons the cache. mise caches a task only when it succeeds, so a failed `check` means the next run pays the full 118s again. A gate that loops on red would pay full price on every attempt.
- The suite is not reliably green. The first run failed on `extensions/sillajje/test/integration/seed.test.ts:91` — "copies a seeded ignored file into the workspace and records it" — which exceeded vitest's 5000ms default. It passed on the next two runs, so it is a timeout under load, not a broken test. A settle gate pointed at it would loop the agent on a failure the agent cannot fix, which is exactly the case the Waiver exists for.
- `mise run ci` is permanently red on this tree: `pnpm run type-aware` reports 6 `lint/suspicious/noUnnecessaryConditions` warnings, one in `extensions/sillajje/src/index.ts:2723` and five in `extensions/sillajje/test/integration/{fold,seed}.test.ts`. `check-baseline.txt` is empty, so nothing is recorded as known-red. A publish gate pointed at `ci` would refuse every fold.
- `ci`'s external suite passed, including a 31s remote clone service test.

**One implementation finding.** The repo's ast-grep `no-shell-c` rule fires on `pi.exec("sh", ["-c", cmd])` at `extensions/sillajje/src/index.ts:513` — the `postInit` call. The check runner's `command` is the same shape ([Checks config schema](01-checks-config-schema.md)), so it will be flagged by the same rule and needs the same inline justification.

**Consequence for the map.** The probe invalidates the example config in [Checks config schema](01-checks-config-schema.md) (`mise run check` on `settle`). What a repo should actually put behind `settle` is a live decision: [Settle gate composition](11-settle-gate-composition.md).
