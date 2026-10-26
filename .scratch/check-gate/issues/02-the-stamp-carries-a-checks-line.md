# 02: The stamp carries a `Checks:` line

**What to build:** With the gate running, every stamped change says what it was checked with. `jj show` on a stamped Interaction lists each check that ran for that Trigger, its verdict, and how long it took — no command line, no output. A reviewer can tell a verified change from one where nothing ran.

**Blocked by:** 01.

**Status:** done

- [x] A stamp whose settle gate ran renders one `Checks:` section in the Commit body, after `Trace` by default.
- [x] The line names each check that ran with its verdict and duration — for example a passed check with its time, or a failed check with its exit code and time.
- [x] A green gate renders. A stamp whose gate was skipped, or a repo that declares no checks, renders no section at all.
- [x] The section is selectable through the existing body-order config and appears in the published JSON schema.
- [x] The verdict reaches the stamp from the gate run that already happened. The stamp never re-runs a check.
- [x] Tests: the rendered description asserted through the integration harness, and the section assembly and ordering through the core's existing body tests.

**Deviation:** Default section order is `[trace, checks, meta, loop, prompt, response]`; a gate that moved the tree appends `; gate modified the working copy`.
