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
    setupFiles: ['./vitest.main.setup.ts'],
    // src/common 은 메인·렌더러 공용 코드다. 렌더러 프로젝트 root 가 src/renderer 라
    // 여기서 함께 돌리지 않으면 어느 프로젝트에도 안 잡혀 조용히 실행되지 않는다.
    include: ['src/main/**/*.test.ts', 'src/common/**/*.test.ts']
  }
});
