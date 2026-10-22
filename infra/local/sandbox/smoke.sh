#!/bin/sh
# Starts the image the way agentgraph starts a run: read-only root, tmpfs /tmp as HOME, the host user, no capabilities.
# Fails when a tool the runs need or opencode's plugin install is missing, or opencode cannot load its config there.
#
#   infra/local/sandbox/smoke.sh [image]
set -eu
image=${1:-${AGENTGRAPH_SANDBOX_IMAGE:-agentgraph-sandbox:local}}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
docker run --rm --pull never --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=1g --user "$(id -u):$(id -g)" \
  --cap-drop=ALL --security-opt no-new-privileges=true --network none -e HOME=/tmp -v "$work:/work" --workdir /work \
  "$image" sh -c '
    for tool in ps rg git cc oxlint oxfmt opencode rustup-init; do
      command -v "$tool" >/dev/null || { echo "missing tool: $tool"; exit 1; }
    done
    for file in node_modules/@opencode-ai/plugin package-lock.json; do
      [ -e "/opt/opencode/$file" ] || { echo "missing /opt/opencode/$file"; exit 1; }
    done
    out=$(opencode debug config 2>&1) || { echo "$out"; exit 1; }
    if echo "$out" | grep -Ei "error|EROFS|read-only"; then exit 1; fi
  '
echo "sandbox smoke: ok"
