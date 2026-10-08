import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { esbuildOptions: { target: 'chrome126' } },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@portal-shared': path.resolve(__dirname, './portal-shared'),
    },
  },
  build: {
    target: 'chrome126',
    outDir: '../renderer',
    emptyOutDir: true,
  },
  base: './',
});
