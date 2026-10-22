# The sandbox image on Node 20, for repos whose dependencies do not install or run on Node 22.
#
#   docker build -t bothub-sandbox:node20 infra/local/sandbox/node20
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS node20

FROM bothub-sandbox:local
USER root
COPY --from=node20 /usr/local/bin/node /usr/local/bin/node
COPY --from=node20 /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=node20 /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/corepack
USER node
