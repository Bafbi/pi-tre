# The v0 baseline

The reference run the prompt loop starts from. Re-baseline only when the task
set, the model split, the scoring, or `v0` itself changes; a new baseline moves
every number below.

## What produced it

```sh
cd extensions/repo-query
node bench/run.ts --variants v0 --tasks all --repeat 3 --concurrency 3
```

| | |
|---|---|
| run directory | `bench/runs/20261109T220834` |
| date | 2026-11-09T22:08:34Z |
| child | `opencode-go/mimo-v2.6-flash`, thinking `high` |
| judge | `opencode-go/deepseek-v4.1-flash`, thinking `high` |
| pi | 1.2.0, tool list hash `1c13251228a5` |
| variant | `v0` (production prompts, fixed but unoptimized) |
| schedule | 8 tasks × 3 repeats, interleaved by round, seed `1393510783` |
| cost | `$0.0801` (child `$0.0397`, judge `$0.0405`) |

24 cells, 0 failed, 0 judge retries, 0 judge errors, 0 fabricated paths.
`promptTokens` was identical across the three repeats of every task, so the
warn-on-drift check stayed silent.

## Ground truth gate

```
$ mise run //extensions/repo-query:bench-verify
[ok]   plimit-clear-queue-error: index.js:84:abortError; index.js:87:reject; index.d.ts:27:clearQueue (+ 4 accepted alternative(s))
[ok]   pqueue-equal-priority-fifo: source/priority-queue.ts:79:priority; source/priority-queue.ts:88:lowerBound; source/lower-bound.ts:3:lowerBound (+ 4 accepted alternative(s))
[ok]   consola-throttle-resolve: src/consola.ts:436:setTimeout; src/consola.ts:399:throttleMin; src/types.ts:28:throttle (+ 4 accepted alternative(s))
[ok]   multi-repo-queue-insert: index.js:57:enqueue; source/priority-queue.ts:88:lowerBound (+ 3 accepted alternative(s))
[ok]   consola-file-reporter: negative task over unjs/consola@c47faac1738b7383971c6c20b5a34ffa15e7cc3b (answer must be "not found"; search terms: reporter, file, searched at least 2 tool calls)
[ok]   consola-options-type: src/types.ts:3:ConsolaOptions; src/types.ts:62:formatOptions (+ 2 accepted alternative(s))
[ok]   consola-log-pipeline: src/consola.ts:353:_logFn; src/consola.ts:451:_log; src/index.ts:33:reporters; src/reporters/basic.ts:78:log (+ 6 accepted alternative(s))
[ok]   pqueue-task-lifecycle: source/index.ts:736:enqueue; source/priority-queue.ts:58:enqueue; source/priority-queue.ts:88:lowerBound; source/lower-bound.ts:3:lowerBound (+ 5 accepted alternative(s))

All 8 tasks verified against their pinned clones.
```

## Per task

| task | det | judge | quality | disagree | promptTokensOurs | billedTokens | q/1k billed | q/1k promptOurs | toolCalls | fabricated |
|---|---|---|---|---|---|---|---|---|---|---|
| plimit-clear-queue-error | 75.0 | 73.3 | 74.2 | 17 | 289 | 16859 | 4.4 | 256.6 | 5 | 0 |
| pqueue-equal-priority-fifo | 62.2 | 84.4 | 73.3 | 22 | 284 | 34207 | 2.1 | 258.2 | 8 | 0 |
| consola-throttle-resolve | 71.1 | 91.1 | 81.1 | 20 | 277 | 14708 | 5.5 | 292.8 | 4 | 0 |
| multi-repo-queue-insert | 100.0 | 91.1 | 95.6 | 9 | 387 | 72972 | 1.3 | 246.9 | 15 | 0 |
| consola-file-reporter | 100.0 | 91.1 | 95.6 | 9 | 267 | 40515 | 2.4 | 357.9 | 17 | 0 |
| consola-options-type | 75.0 | 77.8 | 76.4 | 13 | 283 | 11376 | 6.7 | 269.9 | 4 | 0 |
| consola-log-pipeline | 80.4 | 82.2 | 81.3 | 4 | 298 | 56944 | 1.4 | 272.9 | 15 | 0 |
| pqueue-task-lifecycle | 71.7 | 84.4 | 78.1 | 13 | 299 | 49514 | 1.6 | 261.1 | 12 | 0 |

Mean deterministic 79.4, mean judge 84.4, mean per-cell disagreement 13.4.

## Parent side

```sh
node bench/parent.ts
```

`bench/runs/parent-20261109T215622`, `opencode-go/mimo-v2.6-flash` at thinking
`high`, pi 1.2.0.

| task | called | repos ok | query names symbol | toolPromptTokens | wallMs |
|---|---|---|---|---|---|
| plimit-clear-queue | yes | yes | yes | 289 | 40774 |
| pqueue-fifo | yes | yes | yes | 289 | 277917 |
| compare-queues | yes | yes | yes | 289 | 185523 |

Call rate 100%, tool-prompt cost 289 tokens per request. The `pqueue-fifo`
probe took 278 s of the 300 s timeout: a slow provider day can fail this probe
without anything being wrong with the prompt.

## Reading the baseline

The ceiling is broken. On the old task set five of six tasks scored 94-100; two
now sit near 62 deterministic and four sit below 90 combined, so a prompt change
has room to show.

The binding constraint on the deterministic score is citation precision, not
comprehension:

- **Line misses.** The child cites the blank line above a statement (`index.js:83`
  for `84`, `src/types.ts:61` for `62`). The rule reads the cited line in the
  clone and asks for the symbol, so one line off is a miss. This is the single
  largest source of lost points.
- **Symbol misses from reading instead of searching.** `symbolHit` needs the
  symbol in a tool call's arguments. When the child opens `src/consola.ts` with
  `read` and never greps `throttleMin`, the fact loses 0.35 even though the
  answer names it and the judge sees it as correct. `consola-throttle-resolve`
  loses that fact in all three repeats.
- The judge scores understanding, so it sits above the deterministic score by
  13.4 points on average and by 30 or more on three cells. Those three are where
  the rubric and the judge disagree, and the report lists them.

## What this bench cannot see

- Answer correctness beyond the listed facts.
- An honest answer that never typed the symbol: it loses 0.35 per fact.
- Judge quality beyond one model's reading of one answer with no tools.
- The extension's own wiring, the clone step, and the parent's conversation.
- Absolute cost per `repo_query` call.
- Across models: a score is comparable only within one model and thinking level.
- Repeat noise: quality moves between repeats, and eight tasks is a small sample.
