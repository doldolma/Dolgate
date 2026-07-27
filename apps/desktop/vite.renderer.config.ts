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
      // react-i18next 를 인라인해 Vite 파이프라인(=위의 alias)을 타게 한다. 외부화되면
      // Node 해석으로 로드되어 alias 를 우회하기 때문이다.
      //
      // 다만 중첩 react 자체를 없애는 게 근본이다: 인라인만으로는 부족했다 — 트리를 렌더하는
      // 쪽(@testing-library/react → react-dom)이 외부화된 채 중첩본을 집으면, alias 를 제대로
      // 받은 react-i18next 가 오히려 dispatcher 가 null 인 React 로 훅을 불러 터진다.
      // 그래서 react/react-dom 은 desktop devDependencies 에 두어 패키징 런타임 복사 대상에서
      // 빠지게 했다(scripts/sync-runtime-deps.cjs 주석 참고). 이 인라인은 그 위의 보조 장치다.
      deps: { inline: ['react-i18next'] }
    }
  }
});
