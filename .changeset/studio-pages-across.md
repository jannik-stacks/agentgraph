---
'@jannik-stacks/agi': patch
---

Studio page readers get one host per instance, keyed by name, and an instance that failed to load as its reason. `agi studio --plugins <dir>` or `AGENTGRAPH_STUDIO_PLUGINS` adds studio pages at `/plugins/<name>` that read every served instance; the dashboard example works as one. Pages route exactly, so a studio page and an instance page of one name never stand in for each other, and an instance named `plugins` is refused, as is a plugin in the folder that serves no page. Bench moves out of the studio into `examples/plugins/bench`, with its sets under `plugins.bench.sets`: `--bench`, `AGI_STUDIO_BENCH` and the plugin `engine` member are gone, and Results is the only built-in page.
