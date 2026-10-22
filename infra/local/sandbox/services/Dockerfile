# The sandbox image with PostgreSQL and Redis, for repos whose tests talk to them on localhost. `services` starts both
# under /tmp as the container user and returns, so a score command reads `services && <test command>`.
#
#   docker build -t agentgraph-sandbox:services infra/local/sandbox/services
FROM agentgraph-sandbox:local
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends libnss-wrapper postgresql redis-server \
 && rm -rf /var/lib/apt/lists/*
COPY services /usr/local/bin/services
USER node
