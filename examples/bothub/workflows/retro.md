---
on:
  issue_comment:
    types: [created]
    command: /retro
    guard: { associations: [OWNER, MEMBER, COLLABORATOR] }
steps:
  judge:
    bot: retro
    skill: retro
    over:
      each: node "$BOTHUB_HUB/scripts/retro-items.mjs"
    items: 10
    minutes: 15
human: self-detection pass; scripts/retro.mjs turns finished runs into items on the host, the bot judges one item at a time
---
After a dogfood round, a maintainer runs `node scripts/retro.mjs <data> --hub <hub>` and comments
`/retro` with its output on a retro issue. Each line is one anomaly the run data shows: a step that
stopped silently, a finding no attempt fixed, a retry no check asked for, an environment error.

The retro bot takes the items nobody has judged yet, one at a time. An expected item gets a reply
saying why; a real kink becomes one sub-issue naming the invariant that found it, and stops the
pass until a human answers it. The next `/retro` picks up where the last one stopped.
