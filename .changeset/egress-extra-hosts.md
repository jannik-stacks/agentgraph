---
'@jannik-stacks/agi': patch
---

The egress proxy also allows the hosts listed in `egress/allowlist` in the data folder, so operators add hosts without rebuilding the image. `docker exec agentgraph-egress-1 sh /etc/tinyproxy/start.sh reload` applies a change.
