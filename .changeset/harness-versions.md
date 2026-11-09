---
"@jannik-stacks/agi": patch
---

Record what produced each run in `run.json` `versions`: the engine version, the harness config hash, the image ID and the harness versions it holds. Usage events carry the model the harness reports. Bench and results derive `engine`, `image`, `config`, `harnesses` and `harness-model` labels from that, pin images per `--label`, and warn about done slots that ran other versions. `bin/pins.mjs` lists and sets the Dockerfile pins.
