# Vocabulary

## Ours

| Term | Meaning |
| --- | --- |
| **hub** | Config folder: `hub.yaml`, agents, skills, checks, workflows and scripts |
| **agent** | Role file defining harness, model, tools, proposals and system instructions |
| **harness** | Session program: Claude Code, opencode or pi |
| **workflow** | Ordered steps on an issue, started by an `on` trigger |
| **step** | Agent with a skill, script, or human wait |
| **check** | Script or judging agent that passes or fails a try |
| **try** | One step attempt; retries resume its session |
| **back** | Return to an earlier step with feedback, at most `rounds` times |
| **proposal** | Requested engine action; see [kinds](proposals.md#kinds) |
| **follow-up** | Issue for work outside the current issue's scope |
| **hub change** | Follow-up about bot config, labelled `hub` |
| **run** | One workflow on one issue, until it is done or stopped |
| **aside** | Session fork answering a human at a wait step; can send work back |
| **dispatch** | A `run` proposal starting a child and waiting for its result |
| **feedback** | Check findings, back reasons or human answers; `on: feedback` is also the retro trigger |
| **retro** | Run examining human feedback for recurring misses and possible hub changes |
| **checkout** | A run's working files at a repo commit |
| **sandbox** | Container for sessions or scripts; see [network rules](sandbox.md#the-network) |
| **trace** | A run's event log; see [trace kinds](runs.md#the-trace) |
| **studio** | Web UI for workflows and runs |

"Agent" is the role file, "agentgraph" the system, and "bot" the GitHub account that posts its writes.

## Agent terms

A skill is a file a step hands to its agent; see [skill fields](reference.md#skills). A session is one harness conversation and its history.

## GitHub terms

Event, issue, comment, pull request, label, review, commit, branch and base keep their GitHub meanings. Events use webhook event names; base means the branch a pull request targets.
