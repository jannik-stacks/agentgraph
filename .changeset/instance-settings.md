---
'@jannik-stacks/agi': patch
---

An instance reads its settings from flags, then its `env` file, then `instance.yaml`, then the shell. A loop of several instances ignores the shell's App, tracker, repo, trust, graph and provider settings and says so, so no wrapper has to clear the shell. Run links keep their `/<instance>` path after the provider is set up.
