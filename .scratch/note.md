++ The way of doing the merge of a session on the main is using restore for a squash-merge

++ I'm thinking that using a tag when we archive a session for example could be a good way.
++ the rolling branch would probably not work so well as some session can be done in parallel.


+- the change wq is wrong and generated a response instead of a message and summary.
+- We probably want the agent to not be able to use tools for the session summary generation.

++ we want to have an archive tui to be able to manage the sillajje sessions.

++ unarchive doesn't work on the current session .
++ archiving could set a simple change with [archive] in the message for querying.

++ the bookmark id use could be "sillajje/<user>@<hostname>/<session_id> to be multiuser compatible

++ a `/sillajje rebase <rev> [--session <session_id>]` (run from a session or using --session) that would `jj rebase -s <session_@> -o <rev> -o <session_bookmark>` and `jj wrokspace update-stale` that let us get the latest changes from the x branch (usually main), by making the @ of the session become a merge commit of new change on main and the session branch.
++ a `/sillajje squash <rev> [--session <session_id>]` (also default --session to the current one) that would `jj rebase -s <session_@> -o <rev> -o <session_bookmark>` and `jj wrokspace update-stale` (same as the rebase) (we need it so the session workspace is in sync with the branch we gonna merge on) (also if conflict arise we need to stop and let the user solve or use the agent to solve them), then `jj new <rev> --no-edit` then `jj restore --from <session_bookmark> --to <rev>+` (<rev>+ is the new rev that we created on top of <rev>) then generate a conventional commit message. This is to do a squash-merge of the session into the x branch. 

++ when unarchiving a session we should be doing a merge rebase with default@-

++ the fold commit should Refs the session
++ the fold commit could have more detailed
