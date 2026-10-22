# Where the gate lives

Type: grilling
Status: resolved
Blocked by: —

## Question

The map decided what a check does but never where the code goes. Sillajje has a hard boundary rule: `sillajje-core` composes Actions and never imports pi; the adapter binds ports and renders; `sillajje-jj` owns the jj command line. A check runs an arbitrary shell command, which no existing port covers — `HostPorts` today is `JjPort & SubagentPort & WorkspacePort & StatusPort & ConfigPort`.

Open questions an implementer would hit on line one:

- Does the gate live in the core as a sixth Action, or in the adapter?
- What port runs the command, and does it know about `sh -c`, `CI=1`, and the timeout?
- Where does the 5-attempt loop live — the core, or the adapter?
- The Fold's publish gate needs the same runner. Does Fold call it, or does the adapter run it before calling Fold?

## Answer

Decided as mechanism, not by the user — recorded so nothing is assumed.

**One gate run is core; the loop is the adapter.**

- `packages/sillajje-core/src/check/` exports `runGate(ports, input)` where input is `{ checks, trigger, cwd, cwd-empty, digest, signal }` and the result is per-check `{ name, status, exitCode, durationMs, timedOut }`. It runs the selected checks in declared order, emits `phase: "checking"` per check, applies the path filter, and never loops. The core stays pi-free, and the Fold action can call the same function in-process.
- A new `CommandPort` joins `HostPorts`: `run(input: { command: string; cwd: string; timeoutMs: number; signal?: AbortSignal }) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean; durationMs: number }>`. The adapter binds it to `pi.exec("sh", ["-c", command], { cwd, timeout, signal })` and prepends `CI=1` through the environment. The `sh -c` call carries the same inline justification as `postInit` (`index.ts:513`) for the `no-shell-c` ast-grep rule.
- The adapter owns the maximum-attempts loop, the stall digest, the waiver tool, the transcript report, and the `Checks:` handoff to the stamp. All of those depend on pi's boundary, the agent, and the session, which the core must not know about.
- The Fold action calls `runGate` itself, inside its own pre-transaction step, rather than the adapter running it before calling Fold. The refusal has to be a failed `FoldResult`, which is the core's type.

**Consequence for the module map.** `sillajje-core` gains a fifth capability and a `CommandPort`; `HostPorts` widens; the adapter gains a loop and a tool. No package gains a dependency it does not already have.
