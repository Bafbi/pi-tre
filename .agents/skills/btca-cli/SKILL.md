---
name: btca-cli
description: Use the btca CLI for source-first research across repositories, tools, and documentation. Trigger this skill when the user says "use btca" or when answers should be grounded in real project/library sources (not guesses), especially for architecture, implementation details, or cross-repo/tooling questions.
---

# btca CLI

Use `btca` to answer questions from real sources (local repos, remote repos, tools, docs repos) with a clear, repeatable flow.

## Default workflow

1. **Check available resources first**
   ```bash
   btca resources
   ```
2. **Pick the best resource(s)** for the question.
3. **Use the local repo as the focused query anchor** when the question is project-specific.
4. **Ask an atomic query** (one focused question).
5. **If unsure where the answer is, query multiple resources in one ask.**
6. **Follow up with narrower atomic questions** until the result is actionable.

## Resource strategy

Prefer resources in this order:
1. Current local project repo
2. Relevant upstream/related repo
3. Official docs repository
4. Tool/framework repository

Add resources only when needed:

```bash
# Add local project repo
btca add -n kube-local -t local /absolute/path/to/repo

# Add related upstream repos
btca add -n kubespray https://github.com/kubernetes-sigs/kubespray
btca add -n cilium https://github.com/cilium/cilium
```

Use one-off resources when you don’t want to persist config:

```bash
btca ask -r https://github.com/cilium/cilium -q "Where is policy enforcement initialized?"
```

## Ask atomic queries

Good atomic queries are:
- single-purpose
- scoped to one behavior/component
- answerable with concrete evidence (files/functions/config)

Examples:

```bash
btca ask -r kube-local -q "Where is ENVIRONMENT_ID defined and how is it consumed?"
btca ask -r kubespray -q "Which role installs containerd, and what tasks run first?"
```

Avoid broad prompts like: “Explain the whole architecture.”
Split broad topics into small steps.

## When unsure: use multiple resources

```bash
btca ask -r kube-local -r kubespray -q "How is CNI selected and applied during cluster setup?"
```

Then narrow with follow-up atomic queries on the most relevant resource.

## Quick troubleshooting

- **No resources listed:** add one with `btca add ...`
- **Unknown resource name:** run `btca resources` and use exact names
- **Provider/model issue:** run `btca connect` and retry
