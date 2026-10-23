#!/usr/bin/env bash
# Stops agentgraph and starts the kept bothub containers again on their own volumes. Deletes nothing.
# Only for right after a failed or unhappy migration, before agents run: anything written through
# agentgraph since then stays in the agentgraph volumes only.
# --force-agents skips the running-agents check.
set -euo pipefail
cd "$(dirname "$0")"
force=
case "${1:-}" in
  "") ;;
  --force-agents) force=1 ;;
  *) echo "usage: rollback-to-bothub.sh [--force-agents]" >&2 && exit 2 ;;
esac
dir=$HOME/.agentgraph/migrate
die() { echo "refusing: $*" >&2 && exit 1; }

cat <<EOF
Rollback is for right after a failed or unhappy migration, before agents run.
bothub starts again on its own volumes, which then change; the permanent backup is the read-only
snapshot in $dir/backup. Keys, spend and logins written through agentgraph stay in its volumes only.
EOF

mkdir "$dir/lock" 2>/dev/null || die "a migration or rollback holds $dir/lock (or $dir is missing); if none is running, remove that directory yourself"
trap 'rmdir "$dir/lock"' EXIT
phase=$(cat "$dir/phase" 2>/dev/null || echo none)
case $phase in
  preflight | counted | stopped | backed-up | copied | starting | started | done | rolling-back) ;;
  *) die "phase is '$phase'; nothing to roll back" ;;
esac
procs=$(ps -axo pid=,command= | AGENT_RE='overnight\.sh|bin/(run|bench|bench-run|tune|resume)\.ts|(^|[ /])agentgraph( |$)|/(bench|tune)/' \
  awk -v self=$$ '$1 != self && $0 ~ ENVIRON["AGENT_RE"] && !/migrate-from-bothub|rollback-to-bothub|shell-snapshots\//') || die "ps failed"
ctrs=$(docker ps --format '{{.Names}} ({{.Image}})' --filter ancestor=agentgraph-sandbox:local \
  --filter ancestor=agentgraph-sandbox:services --filter ancestor=bothub-sandbox:local) || die "docker ps failed"
if [ -n "$procs$ctrs" ]; then
  printf '%s\n' "$procs" "$ctrs" | sed '/^$/d; s/^/  /' | cut -c1-160
  [ -n "$force" ] || die "agents are running (listed above); stop them yourself, or pass --force-agents"
fi

if [ "$phase" != rolling-back ]; then echo "$phase" >"$dir/phase-before-rollback"; fi
echo rolling-back >"$dir/phase"

echo "== stop agentgraph (graceful, up to 600s)"
docker compose -p agentgraph --profile sandbox --profile ollama stop -t 600
for v in agentgraph-pgdata agentgraph-chatgpt-auth; do
  out=$(docker ps -q --filter "volume=$v") || die "docker ps failed"
  [ -z "$out" ] || die "a running container still uses $v"
done
out=$(docker ps -q --filter label=com.docker.compose.project=agentgraph) || die "docker ps failed"
[ -z "$out" ] || die "an agentgraph container is still running"

echo "== start bothub"
services=$(cat "$dir/services" 2>/dev/null || echo "postgres litellm egress ollama-relay")
# shellcheck disable=SC2086
docker compose -p bothub start --wait $services
echo rolled-back >"$dir/phase"
echo "bothub is running again; agentgraph is stopped and its volumes are kept"
