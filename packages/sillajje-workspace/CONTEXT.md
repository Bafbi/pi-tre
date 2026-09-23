# Sillajje workspace boundary

Workspace lifecycle and session targeting over the jj boundary. It owns the workspace directory and its jj registration, and it answers which workspace a session owns. It knows the typed `Jj` facade, the session owner, and sillajje's session keys, and nothing of stamping or message generation.

## Language

### Storage

**Workspaces root**:
The directory that holds every session's workspace. Default `~/.pi/sillajje`, configurable as `workspacesRoot`.
_Avoid_: Workspace directory (that is one session's directory)

**Repo slug**:
The repository's directory name under the workspaces root: the basename of the repo root. Two repositories with the same basename share a slug.
_Avoid_: Repo name (it is the basename, not the full path)

### Lifecycle

**Workspace**:
A jj workspace — a separate checkout directory tied to a specific commit. Sillajje creates it at `<workspacesRoot>/<repo-slug>/<session-id>/`, but the registration, not the path, is the identity: jj may record a workspace elsewhere. Each Pi session creates one, and the agent runs inside it.
_Avoid_: Sandbox, clone, checkout

**Workspace name**:
The jj workspace name, `sillajje/<session-key>` — the same string as the session's bookmark. It identifies the repo-side registration. The workspace directory path uses the unqualified session id and omits the owner.
_Avoid_: Workspace id

**Registration**:
jj's repo-side record of a workspace: its name and its working-copy commit. A registration outlives the directory it names.
_Avoid_: Entry, record

**Phantom workspace**:
A registration whose directory has been deleted. `jj workspace list` still shows it with a blank root until `jj workspace forget` runs.
_Avoid_: Stale workspace

**Orphan directory**:
A directory under the workspaces root that no registration in this repo names. It may belong to a different repository that shares the repo slug.
_Avoid_: Leftover, junk

**Archive**:
A manual lifecycle action that keeps the jj branch but deletes the workspace directory jj records (via `jj workspace forget` + `rm`). An archived session cannot accept prompts until unarchived.
_Avoid_: Close, delete, prune

**Unarchive**:
Recreating a workspace directory from the session's `sillajje/<session-key>` bookmark. It reverses Archive.
_Avoid_: Restore, reopen

**Missing workspace**:
The condition where a session's workspace directory no longer exists on disk — deleted by hand, or removed by an archive that did not forget the workspace. A session in this state cannot be used until it is unarchived.
_Avoid_: Stale (that is jj's word for a working copy behind the operation log)

### Session targeting

**Session owner**:
The user and host a session runs on, written `<user>/<host>`. It prefixes the session key, so sessions from different owners never share a bookmark or workspace name.
_Avoid_: Machine (that is one half), author (a commit has an author)

**Session target**:
The sillajje session a subcommand acts on: the current session by default, or the session named by `-s <id>`. A target equal to the current session uses its stored workspace path without a bookmark check. Any other target is validated by the session rule: no `sillajje/<session-key>` bookmark is not a sillajje session; a bookmark owned by another owner is foreign; a bookmark without a workspace is archived.
_Avoid_: Session (the target is which session, not the session itself)

**Foreign session**:
A session whose owner is not the current owner. Its bookmark may arrive through fetch; it is never the current session's target and cannot be unarchived here.
_Avoid_: Remote session (the commit may be local), other user's session (it may be your own other machine)

**Session key**:
The session's qualified identity, `<owner>/<session-id>` — the session owner, a slash, and the session id, or `<session-id>-N` when the base name was taken. The session's bookmark and workspace name are `sillajje/<session-key>`.
_Avoid_: Session id (the key may carry a collision suffix)

**Collision guard**:
The rule that appends a numeric `-N` suffix to the session id when its workspace is already registered, within the session owner's namespace, so two sessions sharing an ID never share a workspace.
_Avoid_: Dedup
