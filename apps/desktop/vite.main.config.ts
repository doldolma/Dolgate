import { mergeConfig } from 'vite';
import baseConfig from './vite.base.config';

const externalMainDependencies = [
  '@anthropic-ai/sdk',
  /^@modelcontextprotocol\/sdk(\/.*)?$/,
  'html-to-text',
  'openai'
];

export default mergeConfig(baseConfig, {
  build: {
    rollupOptions: {
      // AI provider/MCP packages have large server-side dependency graphs and
      // are copied into the packaged app by sync-runtime-deps. Keep the Codex
      // SDK bundled because it is ESM-only and cannot be required by the CJS
      // Electron main entry at runtime.
      external: externalMainDependencies
    }
  },
  test: {
    environment: 'node',
    include: ['src/main/**/*.test.ts']
  }
});
