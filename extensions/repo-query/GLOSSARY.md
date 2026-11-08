# repo-query

Answers questions about external git repositories by cloning them into a per-session temporary root and delegating exploration to a subagent.

## Language

**Tempspace**:
The per-session temporary root that holds clones. Located under the system temp directory as `pi-rq-<session-hash>`, it is created on the session's first query and reused by every later query in that session.
_Avoid_: Workspace, sandbox, cache

**Clone target**:
The directory inside the tempspace that one repository identifier resolves to. It is the unit of reuse and concurrency. A clone target is either a complete clone or absent.
_Avoid_: Repo dir, checkout, clone destination

**Publish**:
The single atomic rename that makes a finished clone visible at its clone target. A clone is fetched into a private temporary directory and then published. Only a publish creates or replaces a clone target.
_Avoid_: Move, promote, install

**Delegate marker**:
The `REPO_QUERY_DELEGATE_V1:<uuid>` string at the end of a delegate task prompt. The child session scans its user messages for the prefix and arms the read-only guard when it finds it.
_Avoid_: Guard token, session tag

**Delegate session**:
A pi session whose branch carries a delegate marker. It may call only the read-only tools, and the process backend is not used for it.
_Avoid_: Subagent session, child session
