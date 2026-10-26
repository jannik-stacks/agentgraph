# Optional steps

Each step here runs only after the user said yes to it. Run `agi check --dir .agentgraph` after any step that
changes the folder.

## Reviewer step

A second agent reads the change and can send it back to the implementor once. Add the agent:

```md
<!-- agents/reviewer.md -->
---
tools: [read, grep, glob, 'bash(git diff*)']
returns: [comment, back]
---
You review a change another model made for an issue. Read it with `git diff "$AGENTGRAPH_BASE"`,
then only the code around it.

Send it back, quoting the lines, when something the issue asks for is missing, when it breaks a caller
the changed code reaches, or when it adds what the issue does not need. Say exactly what to change or
delete. Style and edge cases the issue does not raise are follow-ups in a comment.
```

Then put a step between implement and merge in `workflows/issue.md`:

```yaml
review:
  agent: reviewer
  back: implement
  rounds: 1
  until: the change does everything the issue asks and nothing it does not need
```

## GitHub App and labels

Locally, `agi start` runs on a forge on disk and needs no GitHub. To run on the repo's real issues, the user
creates a GitHub App and installs it on the repo, as the
[App setup](https://github.com/jannik-stacks/agentgraph/blob/main/infra/github/README.md) describes. Walk them
through it; never handle the App key yourself. Then create the label the workflow starts on, with their
consent:

```sh
gh label create agent:ready --description "agentgraph may work on this issue"
```

Commit `.agentgraph/` first: runs on GitHub read the committed graph.

## Calibrate tests in Docker

This runs the tests check once the way a run will: `setup`, then `run:`, in the sandbox image, on a clean
clone, so the repo stays untouched. The image `agentgraph-sandbox:local` exists after the first `agi start`; if
it is missing, say so and stop here.

```sh
git clone --quiet . "$NOTES/clone" && cp -R .agentgraph "$NOTES/clone/"
docker run --rm -v "$NOTES/clone:/work" -w /work agentgraph-sandbox:local sh -c '<setup> && <run>'
```

When it fails, read the output with the user: a missing tool goes in `toolchain`, a step that needs a service
leaves the check and goes in the summary. Delete `$NOTES/clone` afterwards.
