import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Split bundle so the browser can parse each chunk in parallel
    // and cache vendor libraries independently of app code.
    rollupOptions: {
      output: {
        manualChunks: {
          'react-core': ['react', 'react-dom'],
        }
      }
    },
    chunkSizeWarningLimit: 800
  }
})
