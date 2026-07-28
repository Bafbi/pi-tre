# Sillajje

Sillajje is not a VCS, it is a tool/extension that help you version control in an agentic workflow.

This is my take and opinion on my issues with handling VC when doing agentic works. Sillajje uses agent session interaction as his primitive to trace the interactions between the agent and the user as well as the evolution of the repo. It is based on jj (jujutsu) that himself use git as backend, so this is 100% git compatible.

The point is to reduce the overhead of committing and reduce the agent context clutter with git work. It also saves the conversation and work of the agent as compressed generated traces that are directly embedded inside the commits messages, That could later be queried for detailed information.

The extension is firstly an auto workspace, every pi session will create a new jj workspace from @- in a new 'branch' that the agent can interact with it freely (relative toolcall get redirected, and toolcall on the main workspace path get blocked) without breaking anything. Then secondly at the end of every interaction (user prompt -> agent work -> agent response) a stamp is made (jj commit) with a sort of revisited conventional commit line, but that is about the interaction.
