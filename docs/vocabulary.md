# Vocabulary

The words the rest of the docs use. Landscape and GitHub words keep their usual meaning.

## Ours

| Word         | What it is                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **hub**      | The folder of config in a repo: `hub.yaml`, `agents/`, `skills/`, `checks/`, `workflows/`                                |
| **agent**    | A role: harness, model, tools and the proposals it may make. The file body is its system prompt                          |
| **harness**  | The program that runs a session: Claude Code, opencode or pi                                                             |
| **workflow** | Steps that run on an issue when an event matches its `on:`                                                               |
| **step**     | One stage of a workflow: an agent with a skill, a script, or a human                                                     |
| **check**    | A script, or an agent judging, that passes or fails a step after its session ends. Its output goes back as feedback      |
| **try**      | One pass of a step. A failed check means another try, in the same session                                                |
| **back**     | A step's way to an earlier step, `until` a sentence holds, at most `rounds` times. An agent's `back` proposal uses it    |
| **proposal** | A change an agent asks the engine to make: a comment, a label, a push, a pull request, a merge, an issue, an ask, a back |
| **run**      | One workflow on one issue, from its first step to done or stopped                                                        |
| **feedback** | Text carried into the next try or step: a failed check's output, a back reason, a human's answer                         |
| **checkout** | The files a run works in, on its own branch, started from the base                                                       |
| **sandbox**  | The container a session or script runs in. Its only way out is the model proxy and an allowlist                          |
| **trace**    | The lines a run writes: session events, check results, applied proposals, outcomes                                       |
| **studio**   | The web UI that draws workflows and lists runs                                                                           |

"Agent" always means the file. "bothub" means the whole thing. "Bot" is only the GitHub account
that posts comments and opens pull requests.

## Landscape words

**model**, **tool**, **prompt**, **skill** and **session** mean what they mean everywhere. Two
need a line.

- **skill** is a markdown instruction file, `skills/<name>/SKILL.md`, as in Agent Skills. A step
  hands one to its agent.
- **session** is one harness conversation with its history. A try after a failed check resumes it.

## GitHub words

event, issue, comment, pull request, label, review, commit, branch and base. A hub reads them the
way GitHub does: an event is a webhook event, a base is the branch a pull request goes into.
