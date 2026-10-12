import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fumadocsMdx } from 'fumadocs-mdx/vite';
import { defineConfig } from 'vite';
import { bothubCode } from './src/code/plugin.ts';

export const apiPort = 5181;

const server = { port: 5182, strictPort: true, proxy: { '/api': `http://127.0.0.1:${apiPort}` } };

export default defineConfig({
  appType: 'spa',
  plugins: [bothubCode({ root: '..', content: 'content/docs' }), fumadocsMdx({ index: false, macro: { include: 'src/docs/**' } }), react(), tailwindcss()],
  server: { ...server, warmup: { clientFiles: ['./src/main.tsx', './src/docs/DocsView.tsx'] } },
  preview: server,
});
