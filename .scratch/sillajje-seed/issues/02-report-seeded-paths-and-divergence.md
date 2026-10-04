# 02: Report seeded paths and divergence with `/sillajje:seed`

**What to build:** A `/sillajje:seed` command reports what a session seeded and which side moved. A bare invocation lists each seeded path and its state, computed from the hash in the Seed record against the current file on each side. The command writes nothing; it is the read-only view the push and pull directions build on.

**Blocked by:** 01.

**Status:** done

- [ ] A bare `/sillajje:seed` lists each seeded path with its state: unchanged, moved in the Workspace, or moved in the checkout.
- [ ] The state comes from comparing the record hash against the current Workspace file and the current checkout file.
- [ ] `-s @` and no `-s` target the current session; `-s <id>` targets another session.
- [ ] `-h` and `--help` print the command usage.
- [ ] A session with no `seed` list, or none seeded, reports that and takes no other action.
- [ ] The command writes to neither the Workspace nor the checkout.
- [ ] Tests cover the above at the extension integration seam.

## Comments

Built: `-s @` maps to the current session key before the target resolves, so the
current-session exemption applies before the session bookmark exists. A foreign
session's record is read by opening its session log. pi persists a session log
only after its first assistant message, so a message-less session has no
readable record and reports none. The listing also reports `both-moved`,
`workspace-missing`, and `checkout-missing`, beyond the three states in the
ticket.
