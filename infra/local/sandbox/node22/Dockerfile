FROM node:22@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384 AS runtime

FROM agentgraph-sandbox:local
USER root
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=runtime /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/corepack
USER node
