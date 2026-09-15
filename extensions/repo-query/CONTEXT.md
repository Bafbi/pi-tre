# repo-query

Answers questions about external git repositories by cloning them into a per-session temporary root and delegating exploration to a subagent.

## Language

**Tempspace**:
The per-session temporary root that holds clones. Located under the system temp directory as `pi-rq-<session-hash>`, it is created on the session's first query and reused by every later query in that session.
_Avoid_: Workspace (that is sillajje's jj term), sandbox, cache

**Clone target**:
The directory inside the tempspace that one repository identifier resolves to. It is the unit of reuse and concurrency. A clone target is either a complete clone or absent.
_Avoid_: Repo dir, checkout, clone destination

**Publish**:
The single atomic rename that makes a finished clone visible at its clone target. A clone is fetched into a private temporary directory and then published. Only a publish creates or replaces a clone target.
_Avoid_: Move, promote, install
