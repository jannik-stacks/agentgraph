# The sandbox image with Playwright's headless Chromium, for repos whose tests drive a browser. Only the headless shell
# is installed, with the shared libraries it links and one font, so text has a size. A Playwright release finds only
# its own browser revision: build with the repo's `@playwright/test` version.
#
#   docker build -t agentgraph-sandbox:browser --build-arg PLAYWRIGHT_VERSION=1.60.0 infra/local/sandbox/browser
FROM agentgraph-sandbox:local

ARG PLAYWRIGHT_VERSION=1.60.0

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends fontconfig-config fonts-liberation libasound2 libatk1.0-0 libatspi2.0-0 \
      libdbus-1-3 libgbm1 libglib2.0-0 libnss3 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
      libxrandr2 \
 && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN cd /tmp \
 && npm_config_ignore_scripts=true npx -y playwright@${PLAYWRIGHT_VERSION} install --only-shell chromium \
 && rm -rf /root/.npm /tmp/*
USER node
