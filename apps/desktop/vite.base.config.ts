import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const sharedEntry = fileURLToPath(new URL('./src/shared/index.ts', import.meta.url));
const reactEntry = fileURLToPath(new URL('./node_modules/react', import.meta.url));
const reactDomEntry = fileURLToPath(new URL('./node_modules/react-dom', import.meta.url));

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@shared': sharedEntry,
      react: reactEntry,
      'react-dom': reactDomEntry
    }
  },
  build: {
    sourcemap: true,
    emptyOutDir: false
  }
});
