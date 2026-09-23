# 03: Correct the old form on input

**What to build:** When a user submits the retired space form (`/sillajje stamp`, `/sillajje sync -o main`, or bare `/sillajje`), the adapter recognises it on the input event, tells the user which colon command to use instead, and stops the text from reaching the model. A valid colon command is left untouched, and a mistyped colon subcommand falls through to Pi's ordinary unknown-command behaviour.

**Blocked by:** 02 (colon command surface).

**Status:** done

- [x] Submitting `/sillajje stamp` produces a correction notification naming `/sillajje:stamp` and returns `handled`, so no prompt is sent.
- [x] Bare `/sillajje` is caught by the same guard.
- [x] A valid command such as `/sillajje:unarchive` does not trigger the guard.
- [x] An unknown colon subcommand such as `/sillajje:nope` is not caught by the guard.
- [x] Ordinary prompt text is unaffected.

## Notes

- The guard sits first in the `input` handler, before the pending-finalize stamp, so a stale command cannot trigger a stamp. It fires regardless of session lifecycle, so the correction also works in a non-jj directory.
