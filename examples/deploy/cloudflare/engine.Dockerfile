FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-fund --no-audit
COPY . .
ENV AGENTGRAPH_DATA=/data \
    AGENTGRAPH_SANDBOX_URL=http://box.internal \
    AGENTGRAPH_PROXY_URL=http://gateway.internal/v1 \
    AGENTGRAPH_CACHE_VOLUME=
ENTRYPOINT ["sh", "examples/deploy/cloudflare/engine.sh"]
