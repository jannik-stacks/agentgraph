# Context

What a run takes in, what it uses while it works, and what it returns.

A run starts with the bot's role, its offered skills, the forced skill's prompt, the triggering
event and what it may return. Three things add to that: preload before the run, the notes and
earlier runs recall surfaces for its task, and hub tools it calls itself.

| Row         | What it holds                                                                |
| ----------- | ---------------------------------------------------------------------------- |
| **in**      | What the run looks at (`over`) and what it sees first (`preload`)            |
| **uses**    | Harness tools and hub tools                                                  |
| **returns** | The proposal kinds it may hand back; a check returns a verdict, pass or fail |

The studio shows these three rows for every job and check.

## Preload

`preload` renders context into the prompt before the run starts, through `issueContext`,
or switches on recall for it. Without `preload` a run gets neither.

| Value    | What it adds                                                         |
| -------- | -------------------------------------------------------------------- |
| `issue`  | The triggering issue with its comments and the questions asked on it |
| `links`  | Its parent, linked issues and sub-issues                             |
| `recall` | The notes and earlier runs most relevant to the task, below          |

`recall` takes three settings, each optional: `judge`, a model that reads each candidate and drops
the general ones; `cutoff`, the score from 0 to 1 the judge must give a candidate to keep it (0.5);
and `budget`, the most tokens the surfaced text may take (600, about three whole notes).

```yaml
preload: [issue, { recall: { judge: luna } }]
```

## Surfacing

Notes are what the hub knows, surfaced when relevant. A bot never lists the notes it reads. Before
the first model turn the `surfacer` plugin searches accepted notes and the summaries of
earlier runs with the task, and adds the few that matter to the system prompt, each note whole. The
task is the brief a job it `needs` posted on the issue, otherwise the issue's title and body. A run
with neither, such as a check, gets no recall. A resumed session is not surfaced to again.

`weigh` takes the best eight by BM25. A `judge` then drops those it scores under the cutoff, and the rest
are kept in BM25 order, at most three of them within the budget. A judge that does not answer in ten seconds leaves the
BM25 order as it is, and the run's recall event says why. On labelled bothub tasks a chat model as judge cut the general
notes shown by half or more; the small local decision model did no better than chance, so recall has no judge unless one
is set. Proposed, superseded and retired notes are never surfaced.

The surfaced block names `notes_get` and `notes_search`, and a run that recalls gets both tools to
read further. Its judge calls count as `recall` in the run's spend.

Earlier runs are surfaced as far as the reading bot's `history` reaches: `none`, `run` (the same
job's earlier runs for the same event), `issue` (the default, every run on the same issue), `bot`
(its own runs) or `hub` (every run). The `history` tool reaches as far; `runs_read` is hub-wide.
After every run its events are written down as one-line summaries (`summarizeRun`).
Reads and searches that worked are left out, edits become one line per file with how many lines
changed, a command run several times keeps its last run with the line that tells how it went, and
the run ends with how it went and the gist of each failed check. The summaries are extractive by
default; `summarizer` on the bot picks a model instead, or `off`.

## Decider

`decider` on an opencode bot, or on a job to replace the bot's, asks the decision model yes or no
questions while the run works. `on` picks when: before a tool call (`tool_call`, narrowed by
`tools`), after its result (`tool_result`), or on the final message (`stop`). The question sees the
call or the message, the recent steps and the task.

A question in `log` mode, the default, only records its answer as a `decision` event, shown with the
run. In `act` mode an answer under `threshold` denies the tool call with `say` as the reason, or adds
`say` to the result or message as a nudge. When the decision model does not answer, nothing is
denied and the event records why. Tune a threshold in log mode before switching a question to act.

```yaml
decider:
  - on: tool_call
    tools: [edit, write]
    ask: Is the file this call changes one the task names, or clearly needs for it?
```

The surfacer runs inside opencode. pi has no plugins, so a pi run gets no recall.

## Hub tools

`tools` on a bot, narrowed by a job, offers lookups a run calls when it needs them. They read; any
change goes through what the run [returns](proposals.md). opencode gets them from the bothub MCP
server (`serveMcp`); pi has no MCP client, so a pi bot gets preload but no hub tools.

| Tool                        | Reads                                                |
| --------------------------- | ---------------------------------------------------- |
| `issues_list`, `issues_get` | Issues, plans, specs and open questions              |
| `notes_search`, `notes_get` | Every note in the hub, with its status               |
| `runs_read`                 | Earlier runs from the run store                      |
| `history`                   | Summaries of earlier runs the bot may see, by search |

A run whose returns include `note` also gets `notes_add`, which proposes a note while it works.

```yaml
jobs:
  triage:
    type: bot
    bot: triager
    preload: [issue, links, recall]
    tools: [issues_get, notes_search]
```

## Sessions

`resume` says what a new attempt or run of a bot starts with besides its task. `none`, the default,
sends a retry only the failing check findings. `summary` adds the last 40 summary lines of the attempt
before, ending with how it went, and its change so far, and to a job that continues its work on an issue, what its last run did. `session`
continues the harness's own conversation when a run continues or resumes after its question was answered, and when an
attempt ran out of turns: bothub copies the session out of the last run's home into
the new one, and opencode picks it up. A retry after failing checks or unusable proposals starts a fresh session
seeded as with `summary`, so it does not carry the whole conversation again. A run with no session to hand over starts as with `summary`.
pi cannot continue a session yet, so a pi bot with `resume: session` does not load.

```yaml
resume: summary
history: issue
summarizer: extractive
```

## Issues

Issues go through one interface, `Issues`, with two backends picked in `hub.yaml`:

```yaml
issues: github # or local
```

`github` reads and writes real issues in the target repo (`githubIssues`). `local`
keeps them as files (`localIssues`), which is handy for trying a hub without touching
GitHub.

The code is on [Issues and context](reference/context.md).
