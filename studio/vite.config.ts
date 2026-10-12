import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fumadocsMdx } from 'fumadocs-mdx/vite';
import { defineConfig } from 'vite';

export const apiPort = 5181;

const server = { port: 5182, strictPort: true, proxy: { '/api': `http://127.0.0.1:${apiPort}` } };

export default defineConfig({
  appType: 'spa',
  plugins: [fumadocsMdx({ index: false, macro: { include: 'src/docs/**' } }), react(), tailwindcss()],
  server,
  preview: server,
});
