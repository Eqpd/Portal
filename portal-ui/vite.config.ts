import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@portal-shared': path.resolve(__dirname, './portal-shared'),
    },
  },
  build: {
    outDir: '../renderer',
    emptyOutDir: true,
  },
  base: './',
});
