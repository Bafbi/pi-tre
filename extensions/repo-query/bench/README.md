# repo-query prompt benchmark

Measure the two prompt surfaces of the repo-query extension: the child-facing
exploration prompt (`src/prompt.ts`) and the parent-facing tool prompt
(`src/tool-prompt.ts`). Each run reports a quality score, a judge score, and
the provider-tokenized cost of the prompt.

The benchmark is **not hermetic**. It clones repositories from GitHub, spawns a
real `pi` child per cell, asks a real judge model per cell, and **costs money**.
It is not part of `mise run check` or `mise run ci`, and no file here is named
`*.test.ts`, so the default vitest run stays hermetic and fast.

## Two models, on purpose

- The child that answers runs on `opencode-go/mimo-v2.6-flash` at thinking
  `high`. That is the default `--model`.
- The judge runs on `opencode-go/deepseek-v4.1-flash` at thinking `high`. A
  different family from the child, so it does not share the child's mistakes.

Every results file records the child model, the judge model, both thinking
levels, the pi version, the tool list hash, and a UTC date.

## What it measures

**deterministic quality**: 0-100, from fixed ground truth. Per expected fact,
`0.25 × path + 0.35 × symbol + 0.40 × line`, averaged over the facts, then
`× 100`, minus `0.25` per cited path that exists in no clone, floored at 0.

The three terms are strict, because the loose version was free to fake:

- **path** needs a repository-relative path: `src/types.ts`, `./src/types.ts`,
  or `github_unjs_consola/src/types.ts`. A bare basename is not a citation, so a
  file listing buys nothing.
- **symbol** needs the symbol in the answer body *and* in the arguments of some
  tool call (a `grep` pattern, a `path`, a `bash` command). An answer that only
  restates the question never searched for the symbol, so it scores nothing for
  it.
- **line** needs a cited finding whose line really holds the symbol in the run's
  clone. The accepted window is the symbol's own line span in that file, widened
  by `lineSlack`, plus every `accept` alternative the task lists (a usage site, a
  re-export, a test).
- The answer is scored as the parent sees it: cut at 8000 characters by the same
  function the tool uses, so padding cannot raise a score.

**judge quality**: 0-100, one judge call per cell. The judge sees the question,
the expected facts with their notes, the answer, and up to 25 source lines for
each of up to 10 cited findings, read from the clone. It has no tools, so it
cannot explore; it can only check what the answer claims. It scores
`correctness`, `groundedness`, and `usefulness` from 1 to 5, and the score is
`100 × (correctness + groundedness + usefulness) / 15`.

The judge is blind: no variant id reaches it, the answer is labelled
`Answer A`, and the mapping is stored in the results file. One cell per call, so
no cell can contaminate another. A reply that does not parse is retried once,
then recorded as `judgeError` with the axes left null: the run records a missing
score rather than guessing one. A cell whose child run errored is not judged.

**combined quality**: `0.5 × deterministic + 0.5 × judge`. The report prints
both halves and their disagreement, `|det - judge|`. A large disagreement means
the rubric or the ground truth is wrong, not that the answer is average.

**promptTokens**: `input + cacheRead + cacheWrite` of the child's first assistant
message. That is the exact provider-tokenized cost of pi's own prompt, the tool
definitions, our appended prompt, and the task. `input` alone is not enough: the
provider may serve a shared prefix from cache.

**promptTokensOurs**: `promptTokens` minus a floor measured with a one-character
appended prompt. One floor run per task, model, thinking level, pi version, tool
list hash, and base prompt hash, cached in `bench/.cache/floor-*.json`. The hash
is taken from a real cell of the same run, so an upgrade that keeps its version
string still re-measures instead of reusing a stale floor.

**billedTokens**: `input + output + cacheRead + cacheWrite` over the whole child
conversation.

**efficiency**: `quality / billedTokens`, per 1000 tokens. **This one decides.**
Prompt tokens are paid on every turn, so a prompt that is cheaper to send but
makes the child read more is not cheaper. `quality / promptTokensOurs` is the
isolation number: what our appended prompt alone costs, per 1000 prompt tokens.
The report prints both.

## What this bench cannot see

- **Anything the facts do not state.** The deterministic score checks the
  symbols and lines a task lists. A confidently wrong answer that cites those
  correctly still scores well on that half.
- **An honest answer that never typed the symbol.** `symbolHit` needs the symbol
  in a tool call's arguments. A child that only opened whole files with `read`
  loses 0.35 per fact even when its answer is right. The judge half is the
  counterweight; watch the disagreement.
- **Answer quality beyond the rubric.** The judge is one model's reading of one
  answer, with no tools. It cannot verify a claim the answer made about a file
  it did not cite.
- **The extension's own wiring.** The child is a bare `pi` process with
  `read,grep,find,ls,bash`; the extension, the clone step, the TUI, and the
  tempspace are not exercised.
- **Absolute cost per `repo_query` call.** `billedTokens` covers the explorer's
  conversation, not the parent's, and not the clone.
- **Cross-model comparison.** A score is comparable only within one model and
  thinking level. `compare.ts` refuses to mix them for that reason.
- **Two repeats of the same cell are not the same run.** Quality moves between
  repeats; `--repeat 3` and the paired deltas in `compare.ts` make that visible,
  and a 5-of-8 win is still a small sample.

## Tasks

`tasks.json` holds eight tasks pinned by commit SHA: five single-repo lookups,
one two-repo comparison, one negative task, and one type lookup. Two of the
eight need a call chain across three files (`consola-log-pipeline`,
`pqueue-task-lifecycle`). Each record is
`{ id, title, repos, query, negative, expected, lineSlack, evidenceTerms? }`.

An expected fact is `{ path, line, symbol, note, accept? }`. `line` is the
1-based line where `symbol` occurs. `accept` lists other citations that answer
the fact just as well, each as `{ path, lineRange: [a, b], symbol, note }`.
`lineSlack` defaults to 3.

A negative task carries no facts and an `evidenceTerms` list. A clean 1.0 needs
three things: the answer states the fact is absent, no cited path is fabricated,
and at least two tool calls searched for one of those terms. Without the search
evidence the cell scores 0.5, so a lazy "not found" cannot win it.

## Run the ground-truth gate first

Every expected path, line, and accepted alternative is checked against the
pinned clone. Run this before any baseline. It exits non-zero on a mismatch.

```sh
mise run //extensions/repo-query:bench-verify
# or, from this directory:
node bench/verify-tasks.ts
```

It checks that every path exists, that every accepted line range contains the
symbol, and that no path points at `dist/`, `node_modules/`, a build directory,
or a lockfile.

## Run a baseline

```sh
# From the extension directory. Writes bench/runs/<stamp>/.
node bench/run.ts --variants v0 --tasks all --repeat 3 --concurrency 3
```

```sh
# The same run through mise, from the repo root.
mise run //extensions/repo-query:bench -- --variants v0 --tasks all --repeat 3
```

Flags: `--variants a,b`, `--tasks all|id,id`, `--repeat N` (default 3),
`--concurrency N`, `--model <provider/model>`, `--thinking <level>`,
`--judge-model <provider/model>`, `--judge-thinking <level>`, `--no-judge`,
`--seed N`, `--out <name>` (a directory name under `bench/runs/`).
`PI_BENCH_JUDGE_MODEL` overrides the judge model for a one-off.

`--regenerate <runDir>` rebuilds `report.md` from an existing `report.json`
without calling any model. Use it after a change to the report's wording.

Cells are interleaved by round: round 1 runs every (task, variant) pair, then
round 2, then round 3. Within a task the variant order is shuffled with the
recorded seed, so cache warming and provider drift do not line up with a
variant.

The run writes:

- `cells/<variant>/<task>-r<repeat>.jsonl`: the raw child stream.
- `judge/<cell>-a<attempt>.jsonl`: the raw judge stream.
- `report.json`: the run metadata and every cell with its metrics and scores.
- `report.md`: the table, the per-fact detail, the judge rationales, the
  disagreements, and any unstable `promptTokens`.

The run never aborts on one cell, and it exits non-zero when any cell failed.

## Compare two runs

```sh
node bench/compare.ts bench/runs/<baseline> bench/runs/<candidate>
# or, when the candidate changed the prompt on purpose:
node bench/compare.ts <baseline> <candidate> --allow-prompt-change
```

It prints, per shared task, the paired quality delta (candidate minus baseline,
mean over repeats), the deterministic and judge deltas, the `promptTokensOurs`
delta, the `billedTokens` delta, and the outcome. Then a sign test over the
tasks and the verdict:

- the candidate is better when it wins at least 5 shared tasks on quality and
  loses at most 1;
- a tie on quality with a lower billed-token count is a win;
- anything else is inconclusive.

Two runs are only comparable when the child model, thinking level, pi version,
and tool list hash match, and when the prompt bytes of the compared variant are
identical. It refuses anything else and prints what differs. Pass
`--allow-prompt-change` for the one difference a prompt experiment intends.

## Reproduce one task

```sh
node bench/run.ts --tasks consola-throttle-resolve --repeat 1 --concurrency 1
```

Then read the trajectory of that run:

```sh
node bench/trace.ts bench/runs/<stamp>/cells/v0/consola-throttle-resolve-r1.jsonl
```

`trace.ts` prints one line per turn, one line per tool call with a summary of
its arguments and the result size, the cumulative token count, the final answer,
and each finding with its verification result against the cached clone.

## Run the parent-side benchmark

```sh
node bench/parent.ts
# or:
mise run //extensions/repo-query:bench-parent
```

`parent.ts` spawns a parent `pi` with one extension loaded:
`stub-extension.ts` registers `repo_query` with the text from
`src/tool-prompt.ts` and returns a fixed string. For each of three parent
requests it reports whether the model called the tool, which repositories it
passed, whether the query names the task's key symbol, and the tool-prompt token
cost (first-turn prompt tokens minus a floor measured with an empty
description). Output goes to `bench/runs/parent-<stamp>/`. It runs on the child
model, since the parent is a coding agent like the child.

## Prompt variants

`prompt-variants.ts` is the registry. `v0` calls the real
`buildSystemPrompt` and `findingsInstructions` from `src/prompt.ts`, so the
baseline cannot drift from production. Add a variant by adding an entry to
`VARIANTS`; nothing else changes. Select it with `--variants <id>`.

To compare two variants in one run:

```sh
node bench/run.ts --variants v0,candidate --tasks all --repeat 3 --concurrency 3
```

## Clone and floor cache

Clones live in `bench/.cache/<owner>__<repo>@<sha>`. A cache entry is reused
when `git rev-parse HEAD` matches the pinned SHA. Every cell copies its clones
into `bench/runs/<stamp>/clones/` before spawning the child, because
`--tools read,grep,find,ls,bash` still allows `bash` and a child can write.

Delete `bench/.cache` to force a re-fetch. Delete a `floor-*.json` file to
re-measure a floor.

## Files

- `tasks.ts`, `tasks.json`: the task set and its ground truth.
- `clones.ts`: pinned clone cache and per-run copies.
- `harness.ts`: one child run, JSONL parsing, metrics, floor measurement,
  model and pi version constants.
- `score.ts`: findings parsing, path/symbol/line verification, deterministic
  scoring.
- `judge.ts`: the judge prompt, the judge call, and the strict reply parser.
- `run.ts`: the driver, the round schedule, the report.
- `compare.ts`: paired comparison of two runs.
- `prompt-variants.ts`: the variant registry.
- `trace.ts`, `parent.ts`, `stub-extension.ts`: the entry points.
- `verify-tasks.ts`: the ground-truth gate.
- `BASELINE.md`: the recorded v0 baseline the prompt loop starts from.

The block detection and the 8000-character truncation live in
`src/answer-text.ts`, shared by production and `bench/score.ts`, so the two
cannot drift.

Run `mise run //extensions/repo-query:check` after editing any of them. The
extension's `tsconfig.json` includes `bench/**/*.ts`, so `tsc` covers them.
