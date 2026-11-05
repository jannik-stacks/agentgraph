---
'@jannik-stacks/agi': patch
---

One studio serves several instances: repeat `--instance`, or pass none to serve every instance under the data root. Pages live under `/<instance>/`, with a switcher in the header, and an instance's run links add `/<instance>` to `AGENTGRAPH_STUDIO_URL`. Run links posted before this point at `/runs/<id>` and no longer open a run; the studio's `--tracker` now only applies without an instance.
