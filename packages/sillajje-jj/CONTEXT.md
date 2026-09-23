# Sillajje jj boundary

The typed substrate over the `jj` process. It owns every jj command, the deferred-operation transaction, and the parsing of jj output. It knows jj and nothing of sillajje sessions, stamps, or folds.

## Language

**Operation**:
An entry in jj's operation log — the unit jj integrates. A Mutation that changes state produces one.
_Avoid_: Commit, action, step

**Mutation**:
One write verb sent to jj: describe, new, bookmarkSet, duplicate, squash, or rebase. A Mutation is data; the caller states it and the boundary builds the command line.
_Avoid_: Command, step, action (an Action is sillajje's composed capability, one level up)

**Transaction**:
A group of Mutations applied all-or-nothing. Each runs as a Deferred operation chained on the previous, and one integrate publishes the group. A failed Transaction leaves no visible state.
_Avoid_: Batch, unit of work, commit

**Deferred operation**:
An Operation written to the op store but not integrated, so no other command sees it until the Transaction integrates. The boundary applies every Transaction Mutation this way.
_Avoid_: Pending, uncommitted, staging

**Integrate**:
Publishing a Deferred operation into the operation log, making it visible and subject to normal concurrency.
_Avoid_: Commit, publish, apply

**Abandon**:
Removing the Deferred operations a failed Transaction minted, returning the repository to its pre-Transaction state.
_Avoid_: Rollback, revert, undo
