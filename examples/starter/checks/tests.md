---
mode: block
run: '[ ! -f package.json ] || npm run test --if-present'
---
The repo's `test` script passes. A repo without one passes.

Calibrated against passing, failing and absent test scripts in `tests/tracker-cli.test.ts`.
