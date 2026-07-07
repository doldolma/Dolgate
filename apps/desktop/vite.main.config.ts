import { mergeConfig } from 'vite';
import baseConfig from './vite.base.config';

export default mergeConfig(baseConfig, {
  build: {
    rollupOptions: {
      // @openai/codex-sdk pulls the Codex CLI package and native vendor payloads.
      // Keep it as a runtime dependency so Vite does not try to crawl/bundle the
      // CLI resources into the Electron main bundle during release packaging.
      external: ['@openai/codex-sdk']
    }
  },
  test: {
    environment: 'node',
    include: ['src/main/**/*.test.ts']
  }
});
