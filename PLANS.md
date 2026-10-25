# Plans

Ideas we agreed to do later, each with why it waits. Current work lives in [CHAT.md](CHAT.md).

## Engine

- **One trust and push policy above GitHub and the file forge.** Branch and file rules are
  already shared. Trust differs on purpose: GitHub checks the bot's identity and permissions, the
  file forge a configured list. First write down which differences are intended, then extract
  the shared part. About 40 to 80 lines. Waits for the forge policy refactor.
- **Split a proposal into what the agent asked and the exact call we make.** Today one type
  carries both: the agent's request (comment, label, PR) and the GitHub call after our rules ran
  (stamp added, branch fixed, target checked). Splitting makes the rules one visible step. No
  behaviour change. Goes with the forge policy refactor.
- **Priority for issues and runs.** Removed for now. Bring it back only when ordering work
  matters, and then decide where it comes from (a maintainer label, not the bot).

## Plugins

- **Plugins from the target repo.** A repo could ship plugins in `.agentgraph/` as TS files, or
  list plugin packages from its deps. Plugin code runs next to the keys, so these load only from
  the default branch and only when the operator's config opts in. After the first plugin slices.
- **Ship defaults.** Our plugins start the way a user would write them. Once one has proven
  itself, it moves into the SDK exports or the engine.

## Bench and tune

- **Judge grid.** Judges often prefer the floor's diff even when its hidden tests fail. A grid
  of judges and prompts would measure that. Waits for the tune and bench post-mortem.
- **Judges as a tune setting.** Today tune checkpoints judge with the bench panel (opus 1,
  sonnet 2). After the tune redesign, judges are a setting of the tune loop.
