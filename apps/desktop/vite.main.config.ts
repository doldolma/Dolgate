import { mergeConfig } from 'vite';
import baseConfig from './vite.base.config';

export default mergeConfig(baseConfig, {
  build: {
    rollupOptions: {
      external: ['node-pty']
    }
  },
  test: {
    environment: 'node',
    include: ['src/main/**/*.test.ts']
  }
});
