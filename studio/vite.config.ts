import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { makeStudioAuthPlugin } from './auth.ts';
import { makeStudioDevApiPlugin } from './fixtures.ts';
import { makeStudioPagesPlugin } from './plugins.ts';
import { makeServedGraphs } from './served.ts';

const builtins = new Set(builtinModules);

/** Fails the build when browser code imports a Node builtin, which vite would otherwise only stub out. */
const noNodeInBrowser = (): Plugin => ({
  name: 'agentgraph:no-node-in-browser',
  enforce: 'pre',
  resolveId(source, importer, options) {
    if (options.ssr || !importer || importer.includes('/node_modules/')) return;
    if (!source.startsWith('node:') && !builtins.has(source)) return;
    this.error(
      `${importer} imports ${source}, which does not run in the browser; move what the studio needs out of that module`
    );
  },
});

const served = makeServedGraphs();
const pages = makeStudioPagesPlugin(served);
const server = {
  host: process.env.AGI_HOST || '127.0.0.1',
  ...(process.env.AGI_ALLOWED_HOSTS && { allowedHosts: process.env.AGI_ALLOWED_HOSTS.split(',') }),
  port: Number(process.env.AGI_PORT) || 5182,
  strictPort: true,
};
const allow = ['./', '../src/', '../bench/', '../node_modules/'].map(dir =>
  fileURLToPath(new URL(dir, import.meta.url))
);
const deny = ['.env', '.env.*', '*.env', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**'];

export default defineConfig({
  appType: 'spa',
  envPrefix: [],
  cacheDir: `node_modules/.vite-${server.port}`,
  plugins: [
    makeStudioAuthPlugin(served),
    noNodeInBrowser(),
    pages,
    makeStudioDevApiPlugin(served, pages.readStores),
    react(),
    tailwindcss(),
  ],
  resolve: { dedupe: ['yaml'] },
  optimizeDeps: { entries: ['index.html', 'src/**/*.tsx'], include: ['agentation', 'fumadocs-core/highlight'] },
  server: { ...server, fs: { allow, deny }, warmup: { clientFiles: ['./src/main.tsx'] } },
  preview: server,
});
