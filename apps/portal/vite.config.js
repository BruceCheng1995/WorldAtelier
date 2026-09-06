import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
const backend = process.env.WORLD_ATELIER_API || 'http://127.0.0.1:48900'
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1', port: 48910,
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    proxy: {
      '/api': { target: backend },
      '/artifacts': { target: backend },
      '/content': { target: backend },
      '/play': { target: backend, ws: true },
      '/host': { target: backend, ws: true },
    },
  },
  build: { outDir: 'dist' },
})
