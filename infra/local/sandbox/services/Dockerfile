# The sandbox image with PostgreSQL, Redis, libclang (for bindgen) and the en_US.UTF-8 locale, for repos whose tests talk
# to a local database or whose crates generate bindings. `services` starts both under /tmp as the container user and
# returns, so a score command reads `services && <test command>`.
#
#   docker build -t agentgraph-sandbox:services infra/local/sandbox/services
FROM agentgraph-sandbox:local
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends libclang-dev libnss-wrapper locales postgresql redis-server \
 && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/*
COPY services /usr/local/bin/services
USER node
