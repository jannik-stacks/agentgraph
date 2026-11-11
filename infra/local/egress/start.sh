#!/bin/sh
set -e
cat /etc/tinyproxy/allowlist > /tmp/allowlist
[ ! -f /etc/agentgraph/egress/allowlist ] || cat /etc/agentgraph/egress/allowlist >> /tmp/allowlist
[ "$1" != reload ] || exec kill -USR1 1
exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
