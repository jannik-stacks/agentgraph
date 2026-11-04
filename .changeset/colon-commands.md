---
'@jannik-stacks/agi': patch
---

Comment commands now use colons: `/agent:stop`, `/agent:cancel`, `/agent:restart[:step]` and `/agent:<workflow>`. `/agent <text>` is always text. `commands` in `settings.yaml` turns commands off or keeps them to some logins.
