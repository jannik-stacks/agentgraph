#!/bin/sh
set -eu
apt-get update
apt-get install -y --no-install-recommends docker.io docker-compose-v2 docker-buildx git
git clone --branch '${ref}' '${repo}' /opt/src
install -d -o 1000 -g 1000 /var/lib/agentgraph
cd '/opt/src/${dir}/examples/deploy/vps'
install -m 600 -o 1000 .env.example .env
sed -i "s/^DOCKER_GID=.*/DOCKER_GID=$(getent group docker | cut -d: -f3)/" .env
