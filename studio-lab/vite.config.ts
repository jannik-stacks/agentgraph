import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { main: 'index.html', foldkit: 'foldkit.html' } },
  },
})
