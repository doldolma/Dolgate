import { mergeConfig } from 'vite';
import baseConfig from './vite.base.config';

export default mergeConfig(baseConfig, {
  build: {
    rollupOptions: {
      external: [
        'better-sqlite3',
        'keytar'
      ]
    }
  }
});
