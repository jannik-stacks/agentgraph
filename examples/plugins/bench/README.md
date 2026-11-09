# Bench page

This clone-only folder is the studio page for [Bench](../../../docs/bench.md#cost-against-quality).
It imports engine and bench modules from the clone, so it runs from here rather than as a copy.

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
