import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Used only by `make frontend` (HMR on :5173); proxies /api to the running backend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.BACKEND_URL ?? 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
