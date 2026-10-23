#!/usr/bin/env bash
# Stops agentgraph and starts the kept bothub containers again. Deletes nothing.
set -euo pipefail
cd "$(dirname "$0")"
dir=$HOME/.agentgraph/migrate
services=$(cat "$dir/services" 2>/dev/null || echo "postgres litellm egress ollama-relay")
docker compose -p agentgraph --profile sandbox --profile ollama stop
# shellcheck disable=SC2086
docker compose -p bothub start --wait $services
if [ -d "$dir" ]; then echo rolled-back >"$dir/phase"; fi
echo "bothub is running again; agentgraph is stopped and its volumes are kept"
