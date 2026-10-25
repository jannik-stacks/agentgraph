set -eu
cd "$(dirname "$0")/../../.."
if [ -z "${AGENTGRAPH_SANDBOX_URL:-}" ]; then
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
  docker image inspect "$image" > /dev/null 2>&1 || docker build -q -t "$image" infra/local/sandbox
fi
exec node bin/run.ts loop --data "$AGENTGRAPH_DATA"
