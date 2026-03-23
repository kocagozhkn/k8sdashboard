import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/k8s-api': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/k8s-api/, '') || '/',
      },
      '/prometheus': {
        target: 'http://127.0.0.1:9090',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/prometheus/, '') || '/',
      },
    },
  },
})
