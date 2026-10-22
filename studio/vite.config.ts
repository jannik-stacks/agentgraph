import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { builtinModules } from 'node:module';
import { defineConfig, type Plugin } from 'vite';
import { fixtures } from './fixtures.ts';

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

const server = { port: Number(process.env.AGI_PORT) || 5182, strictPort: true };

export default defineConfig({
  appType: 'spa',
  plugins: [noNodeInBrowser(), fixtures(), react(), tailwindcss()],
  resolve: { dedupe: ['yaml'] },
  server: { ...server, fs: { allow: ['..'] }, warmup: { clientFiles: ['./src/main.tsx'] } },
  preview: server,
});
