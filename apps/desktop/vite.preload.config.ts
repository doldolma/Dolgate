import { mergeConfig } from 'vite';
import baseConfig from './vite.base.config';

export default mergeConfig(baseConfig, {
  test: {
    environment: 'node',
    include: ['src/preload/**/*.test.ts']
  }
});
