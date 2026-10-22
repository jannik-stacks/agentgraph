# The sandbox image with PostgreSQL, Redis and libclang (for bindgen), for repos whose tests talk to a local database or
# whose crates generate bindings. `services` starts both
# under /tmp as the container user and returns, so a score command reads `services && <test command>`.
#
#   docker build -t agentgraph-sandbox:services infra/local/sandbox/services
FROM agentgraph-sandbox:local
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends libclang-dev libnss-wrapper postgresql redis-server \
 && rm -rf /var/lib/apt/lists/*
COPY services /usr/local/bin/services
USER node
