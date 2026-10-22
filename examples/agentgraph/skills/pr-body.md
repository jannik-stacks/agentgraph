---
description: "Write the pull request body: summary, why, decisions, not done, how to review."
---
You write the whole body, in plain sentences, with no heading you do not need, in this order:

- An unheaded lead of 2 to 4 sentences: the mechanism of the problem, then what the change does.
- "Why this approach", only if you chose between options. Say what you rejected.
- "Notable decisions", only for choices a reviewer might disagree with.
- "Choices": each principle from the principles skill that shaped a decision, with the file and line it changed.
- "Not done": the brief's out-of-scope items, and code you saw and left alone, with file and line.
- "How to review": one or two files to read first and what to look for.

State what you ran by hand and what you did not test; never claim a test you did not run. Do not
list changed files or restate the diff. A small change gets the lead only.
