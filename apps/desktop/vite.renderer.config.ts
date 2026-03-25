import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import react from '@vitejs/plugin-react';
import baseConfig from './vite.base.config';

const workspaceReactEntry = fileURLToPath(new URL('../../node_modules/react', import.meta.url));
const workspaceReactDomEntry = fileURLToPath(new URL('../../node_modules/react-dom', import.meta.url));

export default mergeConfig(baseConfig, {
  root: 'src/renderer',
  resolve: {
    alias: {
      react: workspaceReactEntry,
      'react-dom': workspaceReactDomEntry
    }
  },
  plugins: [
    react()
  ],
  build: {
    outDir: '../../.vite/renderer/main_window'
  },
  test: {
    environment: 'jsdom',
    setupFiles: '../../vitest.setup.ts'
  }
});
