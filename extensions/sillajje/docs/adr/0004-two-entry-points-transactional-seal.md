# Two stamp entry points and a transactional seal

The stamp module exposes two entry points — `stampSession` and `stampRev` — where it had one (`stamp(input, deps)`), and the Session stamp's seal becomes an all-or-nothing jj transaction built on deferred integration. This ADR supersedes two paragraphs of ADR 0003: **Rev targeting** (`rev?: string` with `rev === "@"` selecting the full seal) and the single-entry-point premise that carried it, including the partial-application contract (`lastCompletedStep`) that documented the states a mid-seal failure could leave behind. ADR 0003 stays the record for the shape (one async call + callback sink), the source axis, the error policy, and the config decision — those carry over unchanged.

## Decisions

**Two named entry points over a tagged union or flat optional fields.**

```ts
stampSession(
	input: { wsPath: string; sessionKey: string; interaction?: Message[] },
	deps: StampDeps,
): Promise<StampResult>

stampRev(
	input: { wsPath: string; rev: string },
	deps: StampDeps,
): Promise<StampResult>
```

Layer 1 (session link) is the function name: a session stamp performs the full seal at a workspace's working copy; a rev stamp describes one revision and nothing else. Layer 2 (context) is the presence of `interaction`: with a transcript the generator runs header+trace from Interaction+diff; without one it runs a conventional header from the diff alone.

The rejected alternatives lost on representable states. Flat optional fields (`rev?`, `interaction?`) allow "transcript + foreign rev" — a state the domain forbids — and push the discriminator into runtime prose. A tagged union restates field presence the signature already shows. With two entry points, `stampRev`'s input has no `interaction` field at all, so the forbidden state is unconstructible, not forbidden by a check. The `rev === "@"` sniffing inside the engine and the `interaction: null` sentinel both disappear.

**`--rev @` is legal and means describe-only.** Describing the caller's workspace working copy without sealing (no bookmark move, no `jj new`) is honest behavior, not a bug to sniff away.

**`Message[]` stays the interaction currency.** ADR 0003's reasoning is reaffirmed against an `InteractionData` alternative: the pi adapter already holds the sliced `Message[]` transcript, so a custom type would add a mapper and a parallel vocabulary for no decoupling sillajje needs — the extension only ever runs inside pi. The dependency on pi's message type stays type-only. `deriveInteractionData` / `extractAssistantText` become private implementation of the module.

**The seal is a deferred-integration transaction.** Prep runs integrated and is allowed to persist: the diff fetch (which snapshots the working copy), `jj workspace update-stale`, and capture of the head operation id. Then describe, bookmark set, and the fresh `jj new` run as a chain of non-integrated operations — each chained on the previous with `--at-op`, each printing the resulting operation id, none visible to other commands or to `jj op log`. One `jj op integrate <last-op>` applies the whole seal at once.

- **Any step fails** → never integrate → the sillage shows nothing: no described change, no moved bookmark, no new change. A best-effort `jj op abandon` removes the dangling chain; a failed abandon is a non-fatal warning. Foreign operations landing mid-transaction integrate cleanly on top.
- **The integrate itself fails** after all steps succeeded → a loud error carrying the operation id, so `jj op integrate <id>` is the documented manual recovery. Divergent-variant aftermath from a rebasing foreign op is reported, never auto-repaired.
- **`lastCompletedStep` is deleted** — the transaction makes the states it documented impossible.

Rejected alternatives:

- *Global `jj op restore`*: repo-wide; it unwinds concurrent sessions' work that landed in the same window. The per-session concurrency model in CONTEXT.md forbids that race.
- *Manual per-step reverse actions* (undescribe, unbookmark, abandon the new change): compensation code that can itself fail, and half of its steps (`jj new`) have no clean inverse.

**Prep stays integrated** because `--at-op` implies `--ignore-working-copy`: transaction steps cannot snapshot disk themselves, so snapshot and staleness plumbing must persist across a failed stamp. "Nothing happened" is defined over sillage-visible mutations — description, bookmark, new change.

**Provenance is module-rendered output.** The commit body's metadata block records the trigger (interaction / manual session / rev stamp), the stamped session's key (never the issuing conversation's), the target rev for rev stamps, the sub-generator model, fallback flags that fired, and pi/sillajje versions supplied via a new `deps.env`. The `message.body.meta.*` toggles gate the block on all stamp paths.

## Consequences

- The adapter decides policy: parse flags, run the three-state session check, resolve the workspace, pick `stampSession` vs `stampRev`, scope side effects (state resets only for a seal on the current session), map statuses and results to notifications. The module owns mechanics.
- `StampDeps` gains `env: { piVersion: string; sillajjeVersion: string }`, read once at activation.
- The transaction runner is internal, tested through the two entry points with the fake `exec` seam; a unit test pins the printed-operation-id format the runner parses.
- The fold flow keeps its direct `jj describe` this change; it is the designated future consumer of `stampRev` (follow-up).
- The new provenance fields ship as the interface hook; richer rendering is a follow-up.
