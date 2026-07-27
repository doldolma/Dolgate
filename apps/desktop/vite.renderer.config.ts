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
// zustand 도 같은 오염 경로로 중첩 복사본이 생기면 vite-node 가 중첩본으로 해석하다
// 모듈을 못 찾아 렌더러 테스트가 깨진다(TermiusImportDialog 등). dedupe 로 루트 단일본에
// 고정한다. 주의: zustand 는 디렉터리 alias 를 걸면 dev 서버가 exports 맵을 우회해
// CJS 진입점을 집어 named export(useStore)가 깨진다 — alias 말고 dedupe 만 쓸 것.

export default mergeConfig(baseConfig, {
  root: 'src/renderer',
  resolve: {
    dedupe: ['lucide-react', 'zustand'],
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
    setupFiles: '../../vitest.setup.ts',
    server: {
      // react-i18next 는 반드시 인라인해야 한다. 기본값이면 vitest 가 node_modules 의존성을
      // 외부화해 Node 해석으로 로드하는데, 그러면 위의 react alias 가 적용되지 않아
      // apps/desktop/node_modules 에 중첩 복사본이 생긴 환경에서 react-i18next 가 중첩 react
      // 를 끌어온다. useTranslation 이 다른 React 인스턴스의 useContext(null) 를 불러 렌더러
      // 테스트가 대량으로 깨진다(로컬은 중첩 복사본 유무에 따라 통과해서 CI 에서만 터졌다).
      // 인라인하면 Vite 파이프라인을 타면서 alias 가 걸려 React 가 하나로 유지된다.
      // 프로덕션 빌드는 렌더러를 통째로 번들해 alias 가 이미 적용되므로 테스트 한정 문제다.
      deps: { inline: ['react-i18next'] }
    }
  }
});
