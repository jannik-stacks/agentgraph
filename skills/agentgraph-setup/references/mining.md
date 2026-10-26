# Mining the repo

The goal is a short ranked list of checks, each tied to evidence. Scripts slice; you judge one chunk at a time.
Never run the repo's code on the host to test an idea; CI history and later sandbox runs show what a command
is worth.

## Sources, in order

| Source | Lines | What to take |
| --- | --- | --- |
| CI config                           | `ci` lines of `slice-repo.mjs`, then the files | Commands every change must pass. Tier 1                            |
| Package scripts, Makefile, justfile | `package-scripts`, `targets`                   | Lint, format, type and build commands CI may not run. Tier 2       |
| Hooks                               | `hook`                                         | What runs before a commit. Tier 2                                  |
| Tool configs                        | `config`                                       | Which linters and formatters exist; confirms tier 1 and 2          |
| Guides                              | `guide`                                        | Written rules. Tier 3 or 4 when a reviewer also enforced them      |
| Commit history                      | `commits`, `churn` of `slice-history.mjs`      | Message style and where changes land                               |
| Pull requests                       | `pulls`                                        | Typical size (median and p90 lines and files), labels, linked issues |
| Review comments                     | `review-comment`, `review`                     | Rules reviewers enforce; the richest source for tiers 3 and 4      |
| Transcripts, opt-in                 | `slice-transcripts.mjs`                        | Rules the user keeps repeating; see [transcripts.md](transcripts.md) |

`slice-history.mjs` reads 300 commits, 100 merged pull requests and 300 review comments by default
(`--commits`, `--prs`, `--comments`). Without `gh` it prints `github available: false`; say so and use git
history alone.

## Reading review comments

Read `review-comment` and `review` lines about 50 at a time. Note every comment that asks for a change that
could recur, as one line:

```
rule: <the change asked for, in general words> | pulls: #12, #40 | role: MEMBER | example: <short paraphrase>
```

Skip one-off bugs, questions, praise and bots. Then merge lines that state the same rule and count distinct
pull requests. Two or more makes a candidate; one is a note for the user. `OWNER`, `MEMBER` and
`COLLABORATOR` weigh more.

For each rule, find the cheapest thing that decides it: a tool the repo has (turn the rule on in the check's
command, or name the setting for the user; never edit the repo's configs), then a regular expression over
added lines, then a question per script-listed item. A whole-diff judge comes last, and needs evidence from
three or more pull requests. [checks.md](checks.md) has the tiers.

## Evidence per candidate

Every row carries what it **decides** in one sentence, **how** (the command, or the script and judge question),
the **mode** (`block` for tier 1, else `warn`), the **evidence** (CI file and line, pull request numbers, a
guide line, or a transcript count; nothing else counts) and the **cost** (rough runtime, one model call per
judged item).

Propose a size check only when reviews asked to split changes, at about the p90 of the `pulls` stats.

## Present the candidates

Show one table, ranked by tier and then by evidence count. Each row: name, what it decides, tier, the exact
command or script, proposed mode, and the evidence (CI file and line, PR numbers, number of transcript
corrections). Below it, list the workflow proposals from [Workflows](#workflows), each with its evidence.

Ask which to add. Add only those: write each check file, name it in a step's `checks:` list in
`workflows/issue.md`, and copy any scripts into `.agentgraph/scripts/`.

## Workflows

The default workflow fits most repos. Propose a change only with evidence:

| Evidence                                                                | Proposal                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| Maintainers often ask clarifying questions or split issues before work  | A triage step before implement, whose agent may `ask` or comment |
| Pull requests often say "stacked on #n"                                 | `stacks: true` in `settings.yaml`                             |
| Reviewers often ask for changes on one kind of file                     | A judged check fanned out over those files, not a new step    |
| Work only starts on a milestone                                         | `milestone:` in `settings.yaml`                               |
| Strangers comment and only some people should steer agents              | `trust:` with maintainer logins the user fills in             |
| Branches are rebased, not merged, before landing                        | `follow: rebase` on the merge step                            |

Logins in `trust:` are the one place a name may enter `.agentgraph/`, and only when the user types them.

## What not to propose

- A check that repeats a slow CI job that rarely fails. Say so and let the user decide.
- A judged check for something a tier 1 to 3 check decides.
- A rule nobody enforced.
- Any change to the engine, the repo's configs or its CI.
