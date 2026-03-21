import { mergeConfig } from 'vite';
import react from '@vitejs/plugin-react';
import baseConfig from './vite.base.config';

export default mergeConfig(baseConfig, {
  root: 'src/renderer',
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
