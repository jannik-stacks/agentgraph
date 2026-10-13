---
name: retro
description: From a /retro comment holding retro items, one issue for each item that is a real kink.
on:
  issue_comment:
    types: [created]
    command: /retro
    guard: { associations: [OWNER, MEMBER, COLLABORATOR] }
jobs:
  judge:
    type: bot
    bot: retro
    skill: retro
    over:
      each: node "$BOTHUB_HUB/scripts/retro-items.mjs"
      max: 10
    returns: [reply, ask]
    tools: [issues_list, issues_get, runs_read]
    mode: warn
    timeout-minutes: 15
human: self-detection pass; scripts/retro.mjs turns finished runs into items on the host, the bot judges one item at a time
---
After a dogfood round, a maintainer runs `node scripts/retro.mjs <data> --hub <hub>` and comments
`/retro` with its output on a retro issue. Each line is one anomaly the run data shows: a job that
stopped silently, a finding no attempt fixed, a retry no check asked for, an environment error.

The retro bot takes the items nobody has judged yet, one at a time. An expected item gets a reply
saying why; a real kink becomes one sub-issue naming the invariant that found it, and stops the
pass until a human answers it. The next `/retro` picks up where the last one stopped.
