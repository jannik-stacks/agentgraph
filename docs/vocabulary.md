# Vocabulary

The terms the rest of the docs use. Common agent and GitHub terms keep their usual meaning.

## Ours

| Term          | What it is                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **hub**       | The folder of config in a repo: `hub.yaml`, `agents/`, `skills/`, `checks/`, `workflows/`                                    |
| **agent**     | A role: harness, model, tools and the proposals it may make. The file body is added to the harness's own system prompt       |
| **harness**   | The program that runs a session: Claude Code, opencode or pi                                                                 |
| **workflow**  | Steps that run on an issue when an event matches its `on:`                                                                   |
| **step**      | One stage of a workflow: an agent with a skill, a script, or a human                                                         |
| **check**     | A script, or an agent judging, that passes or fails a step after its session ends. Its output goes back as feedback          |
| **try**       | One pass of a step. A failed check means another try, in the same session                                                    |
| **back**      | A step's way to an earlier step, `until` a sentence holds, at most `rounds` times. An agent's `back` proposal uses it        |
| **proposal**  | A change an agent asks the engine to make: a comment, a label, a push, a pull request, a merge, an issue, an ask, a back     |
| **follow-up** | An issue an agent files for something the run's issue does not ask for. It waits for a person                                |
| **hub change** | A follow-up about the bot's own workflows, agents or checks, labelled `hub`. It waits for a person                          |
| **run**       | One workflow on one issue, from its first step to done or stopped                                                            |
| **aside**     | A fork of a step's session that answers what a human says at a human step, in a throwaway checkout. Its `back` sends the run back |
| **dispatch**  | One run starting another with a `run` proposal, then waiting until it asks, is done or stops                                 |
| **feedback**  | Text carried into the next try or step: a failed check's output, a back reason, a human's answer. `on: feedback` starts a retro on what a person says or pushes |
| **retro**     | A run that asks how the bot could have avoided what a person said, and files a hub issue when the miss would come back       |
| **checkout**  | The files a run works in, on its own branch, started from the base                                                           |
| **sandbox**   | The container a session or script runs in. A session reaches only the model proxy and an allowlist; a script reaches nothing |
| **trace**     | The lines a run writes: session events, check results, applied proposals, outcomes. An agent with `reads: traces` reads those of every run on its issue |
| **studio**    | The web UI that draws workflows and lists runs                                                                               |

"Agent" always means the file. "bothub" means the whole thing. "Bot" is only the GitHub account
that posts comments and opens pull requests.

## Agent terms

Model, tool, prompt, skill and session keep their usual meanings. Two need a line:

- A skill is a Markdown instruction file: `skills/<name>.md` or `skills/<name>/SKILL.md`. Agent Skills uses the folder form. Its frontmatter may hold a `description` and `uses`, the skills whose bodies follow its own. A step hands one to its agent.
- A session is one harness conversation with its history. A try after a failed check resumes it.

## GitHub terms

Event, issue, comment, pull request, label, review, commit, branch and base keep their GitHub meanings. An event is a webhook event. A base is the branch a pull request goes into.
