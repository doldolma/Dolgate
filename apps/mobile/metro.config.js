const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('node:path');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const projectNodeModules = path.resolve(projectRoot, 'node_modules');
const rootNodeModules = path.resolve(workspaceRoot, 'node_modules');
/**
 * Fig 제너레이터 모듈이 있는 곳.
 *
 * **복사하지 않고 그 자리를 가리킨다.** 713개 11.3 MB 라 사본을 두면 저장소가 그만큼 또
 * 불어나고, 스펙을 갱신할 때 둘이 어긋날 자리가 하나 더 생긴다. 생성기가 찍는 곳은 한
 * 군데이고(apps/desktop/scripts/generate-command-specs.cjs) 데스크톱은 Vite 로, 모바일은 이
 * 별칭으로 같은 파일을 읽는다.
 */
const commandSpecModules = path.resolve(
  workspaceRoot,
  'apps/desktop/src/renderer/generated/command-spec-modules',
);

const workspacePackages = [
  path.resolve(workspaceRoot, 'packages', 'shared-core'),
  path.resolve(workspaceRoot, 'packages', 'fressh-react-native-xtermjs-webview'),
  path.resolve(workspaceRoot, 'packages', 'react-native-remote-desktop'),
];

/** AWS SDK 를 ESM 빌드로 해석할 때 쓰는 순서. 아래 resolveRequest 주석 참고. */
const awsMainFields = ['react-native', 'browser', 'module', 'main'];
/** DOM 매핑을 타지 않게 할 때 쓰는 순서(browser·react-native 를 뺀다). */
const domFreeMainFields = ['module', 'main'];

const config = {
  watchFolders: [rootNodeModules, ...workspacePackages, commandSpecModules],
  resolver: {
    unstable_enableSymlinks: true,
    nodeModulesPaths: [projectNodeModules, rootNodeModules],
    extraNodeModules: {
      react: path.resolve(projectNodeModules, 'react'),
      'react/jsx-runtime': path.resolve(projectNodeModules, 'react/jsx-runtime.js'),
      'react/jsx-dev-runtime': path.resolve(
        projectNodeModules,
        'react/jsx-dev-runtime.js',
      ),
      'react-native': path.resolve(rootNodeModules, 'react-native'),
      'command-spec-modules': commandSpecModules,
    },
    /**
     * AWS SDK 두 가지 우회. 둘 다 없으면 **번들이 아예 만들어지지 않거나**(개발·릴리즈 모두)
     * 기기에서 첫 XML 응답에 죽는다.
     *
     * 1. **CJS 로 잡히면 Node 런타임 설정이 딸려 온다.** 기본 해석 순서(react-native → browser
     *    → main)는 `main`(dist-cjs)을 집는데, AWS SDK 의 `react-native` 매핑은
     *    `./dist-es/runtimeConfig` 만 가리킨다. 그래서 CJS 로 들어가면 @smithy/node-http-handler
     *    가 따라오고 `node:http2`·`node:stream` 을 요구해 해석이 실패한다. ESM 으로 해석하면 그
     *    매핑이 살아 fetch 핸들러 설정이 잡힌다. 전역으로 `module` 을 앞세우면 모든 패키지의
     *    해석이 바뀌므로 AWS SDK 로 범위를 좁힌다.
     *
     * 2. **XML 파서는 반대로 DOM 매핑을 피해야 한다.** @aws-sdk/xml-builder 는 `browser` 와
     *    `react-native` 를 **둘 다** `xml-parser.browser` 로 매핑하는데 그것이 `DOMParser` 를
     *    쓴다 — Hermes 에 없는 DOM API 라 "Property 'DOMParser' doesn't exist" 로 죽는다. 같은
     *    패키지의 `xml-parser.js` 는 DOM 없이 도는 자체 파서라 폴리필도 새 의존성도 필요 없다.
     *    import 가 상대 경로(`./xml-parser`)라 패키지 이름으로는 못 걸러서 **원본 파일 위치**로
     *    판정한다.
     */
    resolveRequest: (context, moduleName, platform) => {
      if (
        moduleName.endsWith('xml-parser') &&
        context.originModulePath?.includes(
          `${path.sep}@aws-sdk${path.sep}xml-builder${path.sep}`,
        )
      ) {
        return context.resolveRequest(
          { ...context, mainFields: domFreeMainFields },
          moduleName,
          platform,
        );
      }
      if (moduleName.startsWith('@aws-sdk/') || moduleName.startsWith('@smithy/')) {
        return context.resolveRequest(
          { ...context, mainFields: awsMainFields },
          moduleName,
          platform,
        );
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
