import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const sharedEntry = fileURLToPath(new URL('./src/shared/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@shared': sharedEntry
    }
  },
  build: {
    sourcemap: true,
    emptyOutDir: false
  }
});
