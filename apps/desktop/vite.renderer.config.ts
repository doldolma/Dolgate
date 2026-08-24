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
    // **한 테스트에 주는 총 시간.** vitest 기본값은 5초인데, 이 스위트의 비동기 단언
    // (waitFor·findBy)은 하나당 3초까지 기다릴 수 있다(vitest.setup.ts 의 asyncUtilTimeout).
    // 순차로 세 번 기다리는 테스트가 흔해서, 워커가 잠깐 굶으면 단언은 아직 여유가 있는데
    // **테스트 상한이 먼저 닫혀** 산발적으로 실패했다(단독 실행은 늘 통과 — 실기기에서
    // 시뮬레이터·번들러를 함께 돌릴 때 겪었다).
    //
    // 상한을 늘려도 진짜 실패는 그대로 3초에 "요소를 찾을 수 없다"로 잡힌다 — 바뀌는 것은
    // 멈춘 테스트가 죽기까지 걸리는 시간뿐이다.
    testTimeout: 20_000,
    // 훅도 같은 이유다. beforeEach 가 무거운 트리를 그리는 파일이 있다.
    hookTimeout: 20_000,
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
