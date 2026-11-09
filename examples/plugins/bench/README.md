# Bench page

This example plugin supplies the [Bench studio page](../../../docs/bench.md#cost-against-quality).
The runner and scorer live separately in the engine clone at `bin/bench.ts` and `bench/`. Run this plugin from the clone; its imports require that layout.

Pass it as the studio's plugins folder:
`agi studio --plugins examples/plugins/bench`, or from `studio/`,
`npm run dev -- --plugins ../examples/plugins/bench`.
The page is `/plugins/bench` and reads every served instance.

To add bench sets, write a `settings.yaml` next to this README:

```yaml
plugins:
  bench:
    sets: [/abs/path/to/set]
```

Each set's `data` store joins the instances' runs. Paths must be absolute.
