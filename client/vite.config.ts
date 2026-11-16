import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The client reads NO environment variables. Public runtime settings come from GET /api/config,
// so provider keys and secrets can never be inlined into the bundle. The prefix below is
// deliberately one that nothing in .env uses.
export default defineConfig({
  plugins: [react()],
  envPrefix: 'MAHILASATHI_CLIENT_PUBLIC_',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        // Framework code changes rarely: a separate chunk stays cached across app updates.
        manualChunks: { vendor: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query', 'zod'] },
      },
    },
  },
});
