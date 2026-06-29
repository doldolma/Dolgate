import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import baseConfig from './vite.base.config';

const workspaceReactEntry = fileURLToPath(new URL('../../node_modules/react', import.meta.url));
const workspaceReactDomEntry = fileURLToPath(new URL('../../node_modules/react-dom', import.meta.url));
// 패키징 단계(sync:runtime-deps)가 apps/desktop/node_modules로 런타임 의존성을 복사하면
// react/react-dom뿐 아니라 lucide-react도 중첩 복사본이 생긴다. lucide-react를 alias/dedupe로
// 루트 단일본에 고정하지 않으면, 외부화된 중첩 lucide가 중첩 react를 끌어와 아이콘 렌더 시
// React dispatcher가 null이 되어(useContext) 렌더러 테스트가 대량 실패한다.
const workspaceLucideReactEntry = fileURLToPath(
  new URL('../../node_modules/lucide-react', import.meta.url),
);

export default mergeConfig(baseConfig, {
  root: 'src/renderer',
  resolve: {
    dedupe: ['lucide-react'],
    alias: {
      react: workspaceReactEntry,
      'react-dom': workspaceReactDomEntry,
      'lucide-react': workspaceLucideReactEntry
    }
  },
  plugins: [
    react(),
    tailwindcss()
  ],
  build: {
    outDir: '../../.vite/renderer/main_window'
  },
  test: {
    environment: 'jsdom',
    setupFiles: '../../vitest.setup.ts'
  }
});
