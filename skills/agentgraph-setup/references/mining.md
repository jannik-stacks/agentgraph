# Mining the repo

The goal is a short ranked list of checks, each tied to evidence. Scripts slice; you judge one chunk at a time.
Never run the repo's code on the host to test an idea. A command's worth shows in CI history and in later
agentgraph runs, which happen in the sandbox.

## Sources, in order

| Source                              | Script or file                                 | What to take from it                                                                                              |
| ----------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| CI config                           | `ci` lines of `slice-repo.mjs`, then the files | The commands every change must pass. Tier 1.                                                                      |
| Package scripts, Makefile, justfile | `package-scripts`, `targets`                   | Commands for lint, format, types, build that CI may not run. Tier 2.                                              |
| Hooks                               | `hook`                                         | What runs before a commit: lint-staged, pre-commit, commitlint. Tier 2.                                           |
| Tool configs                        | `config`                                       | Which linters and formatters exist, and how strict. Confirms tier 1 and 2 commands.                               |
| Guides                              | `guide`                                        | Written rules: CONTRIBUTING, AGENTS.md, PR templates, CODEOWNERS. Tier 3 or 4 when a reviewer also enforced them. |
| Commit history                      | `commits`, `churn` of `slice-history.mjs`      | Message style (conventional share, subject length, bodies, trailers) and where changes land.                      |
| Pull requests                       | `pulls`                                        | Typical size (median and p90 changed lines and files), labels, linked issues, body length.                        |
| Review comments                     | `review-comment`, `review`                     | Rules reviewers enforce. The richest source for tier 3 and 4.                                                     |
| Transcripts, opt-in                 | `slice-transcripts.mjs`                        | Rules the user keeps repeating to agents. See transcripts.md.                                                     |

`slice-history.mjs` reads 300 commits, 100 merged pull requests and 300 inline review comments by default
(`--commits`, `--prs`, `--comments`). Without `gh` it prints `github available: false`; say so and go on with
git history alone.

## Reading review comments

Read `review-comment` and `review` lines in chunks of about 50. For each chunk, write down every comment that
asks for a change of a kind that could recur, as one line:

```
rule: <the change asked for, in general words> | pulls: #12, #40 | role: MEMBER | example: <short paraphrase>
```

Skip one-off bug reports, questions, praise and bot output. After all chunks, merge lines that state the same
rule and count the distinct pull requests. A rule enforced on two or more pull requests is a candidate; a
single one is a note for the user. Weigh comments by `OWNER`, `MEMBER` and `COLLABORATOR` above others.

Then ask of each rule: which tool decides it? In this order:

1. A tool the repo already has decides it (a lint rule that is off, a typecheck flag). Propose turning the tool
   on in the check's command, or name the setting for the user to change. Never edit the repo's configs.
2. A regular expression over added lines decides it (`any`, `console.log`, a banned import, a missing license
   header). Tier 3, `assets/rules.mjs`.
3. A script can list the items and one yes-or-no question per item decides it (each new exported name, each
   changed public function, each new dependency). Tier 4 with `each:`.
4. Only a reading of the whole change decides it. A whole-diff judge, last, and only with evidence from three
   or more pull requests.

## Evidence per candidate

Every row you show the user carries:

- **decides**: one sentence on what passes.
- **how**: the exact command, or the script plus the judge question.
- **mode**: `block` for tier 1, `warn` for everything else.
- **evidence**: CI file and line, pull request numbers with a count, a guide file and line, or a transcript
  count. Nothing else counts as evidence.
- **cost**: rough runtime (a full build is minutes, a regex is instant) and for judges, one model call per item.

Size limits come from the `pulls` stats: propose a size check at about the p90 of changed lines and files,
never the median, and only when reviews asked to split changes.

## Workflows

The default workflow (implement, review, wait for a human merge) fits most repos. Propose a change only with
evidence, and show it as a proposal:

| Evidence                                                                                            | Proposal                                                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Many issues get clarifying questions from maintainers before work starts, or issues are often split | A triage step before implement, with an agent that may `ask` or comment a brief |
| Pull requests in the history often say "stacked on #n" or depend on each other                      | `stacks: true` in `settings.yaml`                                               |
| Reviewers often ask for changes on one kind of file (docs, migrations, public API)                  | A judged check fanned out over those files, not a new step                      |
| Work only starts on a milestone                                                                     | `milestone:` in `settings.yaml`                                                 |
| Strangers comment on issues and only some people should steer agents                                | `trust:` with the maintainer logins, which the user fills in                    |
| The branch must be rebased, not merged, before landing (linear history, rebase-only merges)         | `follow: rebase` on the merge step                                              |

Logins in `trust:` are the one place a name may enter `.agentgraph/`, and only when the user types them.

## What not to propose

- A check that repeats one CI runs anyway after the pull request opens, when it takes more than a few minutes
  and rarely fails. Say so and let the user decide.
- A judged check for something a tier 1 to 3 check already decides.
- A rule nobody enforced, because it sounds good.
- Any change to the engine, the repo's own configs or its CI.
