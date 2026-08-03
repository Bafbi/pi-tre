# Result/error patterns for the stamp module — research findings

**Question**: What are the established patterns for an async TypeScript module's result/error surface, and which fits the stamp module? Secondary: how do real codebases stream status from a long-running async operation?

**Sources**: primary — rust-lang/book (official Rust book), supermacro/neverthrow, gcanti/fp-ts, effect-ts/effect, sindresorhus/execa, oclif/oclif, microsoft/vscode, listr2/listr2 (all read from source, commit pinned per repo).

---

## 1. Expected failures are values, not exceptions — the consensus

- **Rust** (the canonical framing, `src/ch09-03-to-panic-or-not-to-panic.md`): *"returning `Result` is a good default choice when you're defining a function that might fail"* — `Result<T, E> = Ok(T) | Err(E)`; `panic!` is for unrecoverable. Returning `Result` gives the caller options: *"The calling code could choose to attempt to recover... or it could decide that an `Err` value in this case is unrecoverable"*.
- **neverthrow** (`src/result.ts:62`): `type Result<T, E> = Ok<T, E> | Err<T, E>` (concrete classes, `ok()`/`err()` constructors; `ResultAsync<T,E>` wraps a promise). README: *"Throwing and catching is very similar to using goto statements... by using `throw` you make the assumption that the caller of your function is implementing `catch`. This is a known source of errors."* Its `eslint-plugin-neverthrow` forces consumption — *"essentially a porting of Rust's `must-use` attribute"* (README).
- **fp-ts** (`src/Either.ts:116`): `type Either<E, A> = Left<E> | Right<A>` — a `_tag`-discriminated union; getting-started doc: *"Instead of throwing exceptions or returning `null`, you model the absence explicitly and handle it with combinators."*
- **Effect** (the sharpest framing, `packages/effect/src/Effect.ts`): typed error channel vs defect. `Effect.fail(e)` → recoverable, typed `E`; `Effect.die(x)` → *"a critical and unexpected error"*, error channel becomes `never`. `Effect.catch` *"only handles recoverable errors... will not recover from unrecoverable defects"*; `catchDefect` handles thrown exceptions. Thrown exceptions are *defects by default*, not typed failures.
- **Bridges for throwing code exist in all three**: neverthrow `Result.fromThrowable` / `ResultAsync.fromPromise(promise, errorFn)`; fp-ts `Either.tryCatch(f, onThrow)`; Effect `Effect.try` / `Effect.promise`.

## 2. The closest analogue to our ExecFn: execa

execa runs a subprocess — exactly our `jj` situation. A non-zero exit is an **expected failure**, and it is a **value, not an exception** by default shape:

- Result shape is one uniform object: `failed: boolean`, `exitCode`, `stdout`, `stderr`, plus error-only fields on failure (`message`, `code`, `cause`, `signal`) — `types/return/result.d.ts`, `lib/return/result.js`.
- Branching: default rejects with the error, but `reject: false` **resolves with the same error object** — the documented canonical branch is `const resultOrError = await execa({reject:false}); if (resultOrError.failed) {...}` (`docs/errors.md`). The error *is* the result, distinguished by the `failed` flag.
- The throw-vs-return choice is a **call-site option** (`reject`), decided in one place (`lib/return/reject.js:5`): *"if (result.failed && reject) throw result; return result;"*.

oclif's own commands: success = `run()` resolves, failure = `this.error(...)` throws (`@oclif/core`'s `success`/`fail` methods live in the unpinned dependency — not verifiable from this repo).

## 3. Status/progress streaming — push, not pull

Both mature streaming codebases use **push-based** status:

- **VS Code** (`src/vscode-dts/vscode.d.ts:7656,11619`): `Progress<T> { report(value: T): void }` — a *callback sink*; the value is a small object `{ message?, increment?, total? }`. Frequency control lives in the plumbing, not the producer: `@throttle(100, merge)` at the extension-host boundary (`src/vs/workbench/api/common/extHostProgress.ts`), plus UI delay/min-display. Lifecycle bookends (`$startProgress`/`$progressEnd`); cancellation via `CancellationToken`.
- **listr2** (`packages/listr2/src/lib/event-manager.ts`): a thin typed wrapper over Node's `EventEmitter`, with an event map (`TITLE, STATE, OUTPUT, MESSAGE, ...`) and a task-state enum (`WAITING, STARTED, COMPLETED, FAILED, SKIPPED, ...` — `constants/listr-task-state.constants.ts`). Events are **unthrottled, producer-controlled**; renderers subscribe (`renderer/verbose/renderer.ts`) or repaint on a coarse refresh signal. A `SKIPPED` state exists alongside `FAILED` — a normal terminal state, distinct from failure.
- Both are callback/emitter push — neither uses async iteration. Granularity is a separate concern from the stream's transport.

## 4. Application to the stamp module

Mapping the research onto our design (codebase-design vocabulary):

| Design point | Research says | Verdict |
|---|---|---|
| Discriminated `StampResult` (`ok: true` / `ok: false` + reason) | The consensus: Rust `Result`, neverthrow `Ok/Err`, fp-ts `Left/Right`, execa `failed` flag — all discriminated unions, narrowed by a tag | Keep |
| Expected failures → results, never throws (jj non-zero exit, sub-generator exhaustion) | Rust: "returning `Result` is a good default"; execa: expected failure is a value; Effect: only *defects* escape | Keep — a jj `describe` failing is recoverable-and-reportable, not a defect |
| `no-changes` distinct from `failed` | listr2's `SKIPPED` vs `FAILED`; fp-ts "model the absence explicitly" | Keep — it is a normal terminal outcome |
| Typed reason codes, narrowed by the discriminator | neverthrow's typed `E`, Effect's typed error channel, execa's `code` field | Keep — reasons as a string-literal union, narrowed after the `ok` check |
| `onStatus` callback sink, infallible | VS Code `Progress.report` (push callback, small value object); listr2 typed events (enums + payloads); frequency is a separate concern | Keep — push sink matches; statuses are few, no throttle needed |
| Bugs throw (adapter catches), expected outcomes return | Effect's `fail` vs `die`; neverthrow "defects" | Keep |

**Two things the research surfaces that we should note, not adopt now:**

1. **execa's `reject` toggle** — a call-site throw-vs-return option. We have exactly one consumer (the adapter) that always wants values; a toggle would be a hypothetical seam. Skip.
2. **Throttling** (VS Code's 100ms merge) — needed for high-frequency progress (percentages, byte counts). Our statuses are a handful of phases/warnings/errors per stamp; no throttle needed. If a phase ever floods, the sink is the place to throttle.

**Recommendation**: the proposed design stands — discriminated `StampResult` with typed reason codes, expected failures as values, `no-changes` as a distinct outcome, `onStatus` push sink with a typed union, bugs may throw. Every element is the established pattern in at least two primary sources.

## Sources

- rust-lang/book — `src/ch09-02-recoverable-errors-with-result.md`, `src/ch09-03-to-panic-or-not-to-panic.md`
- supermacro/neverthrow — `src/result.ts`, `src/result-async.ts`, `README.md`
- gcanti/fp-ts — `src/Either.ts`, `docs/guides/getting-started.md`
- effect-ts/effect — `packages/effect/src/Effect.ts`, `Exit.ts`, `Cause.ts`
- sindresorhus/execa — `types/return/result.d.ts`, `lib/return/reject.js`, `lib/return/result.js`, `docs/errors.md`, `docs/api.md`
- microsoft/vscode — `src/vscode-dts/vscode.d.ts`, `src/vs/workbench/api/common/extHostProgress.ts`, `src/vs/platform/progress/common/progress.ts`
- listr2/listr2 — `packages/listr2/src/lib/event-manager.ts`, `constants/listr-task-state.constants.ts`, `interfaces/listr-task-event-map.interface.ts`, `renderer/verbose/renderer.ts`
