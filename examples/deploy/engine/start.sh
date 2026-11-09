set -eu
cd "$(dirname "$0")/../../.."
[ -f "$AGENTGRAPH_DATA/live/instance.yaml" ] || {
  echo "provision $AGENTGRAPH_DATA/live/instance.yaml and its checkout before starting the engine; see docs/hosting.md" >&2
  exit 1
}
if [ "${AGENTGRAPH_RUNNER:-local}" = local ]; then
  tries=0
  until docker info > /dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || {
      echo "no docker daemon at ${DOCKER_HOST:-/var/run/docker.sock}" >&2
      exit 1
    }
    sleep 2
  done
  docker compose -f examples/deploy/engine/sidecars.yaml up -d --wait
  image=${AGENTGRAPH_IMAGE:-agentgraph-sandbox:local}
  if ! docker image inspect "$image" > /dev/null 2>&1; then
    if [ "$image" != agentgraph-sandbox:local ]; then
      echo "missing custom image $image; run docker pull $image on the runner host" >&2
      exit 1
    fi
    docker build -q -t "$image" infra/local/sandbox
  fi
fi
exec node bin/run.ts loop --instance live --data "$AGENTGRAPH_DATA"
