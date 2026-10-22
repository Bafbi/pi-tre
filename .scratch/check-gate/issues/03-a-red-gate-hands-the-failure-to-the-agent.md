# 03: A red gate hands the failure to the agent

**What to build:** A failing settle gate no longer just notifies — it tells the agent what broke and gives it another turn. The agent reads the real output, fixes what it can, and settles again. The chase is bounded by a five-attempt cap and ends early when the agent stops changing anything, and the Interaction always stamps.

**Blocked by:** 02.

**Status:** done

- [x] A red settle gate appends a Check report as a displayed custom message to the transcript and asks for one more turn, so the agent sees it before settling.
- [x] The report is the raw output of the failing checks, truncated to the last 2000 lines or 50KB, whichever comes first, with a pointer line naming the complete output. The complete output is written outside the workspace so it never enters a stamp's diff.
- [x] The gate runs at most five times per Interaction. The fifth red settles, and the user is notified that the gate gave up.
- [x] A red gate settles immediately when the interaction's diff digest equals the previous attempt's, instead of spending another attempt.
- [x] The Interaction stamps whatever the verdict, including after the cap and after a stall.
- [x] The Record carries the attempt number alongside the per-check results.
- [x] Tests: red then green, red five times, red twice with an unchanged tree, and an aborted run, all through the integration harness with real shell commands.

**Deviation:** Full logs live at `<workspace>.checks/<check>.log`, a sibling of the workspace; the report tail is capped at 2000 lines or 50KB.
