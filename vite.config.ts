import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve('apps/dashboard/client'),
  plugins: [react()],
  build: {
    outDir: resolve('dist/apps/dashboard/client'),
    emptyOutDir: true,
    sourcemap: true,
  },
});
