const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// node 로 스크립트를 직접 돌리는 테스트라 CJS 로 둔다. RN 앱의 tsconfig 에는 node 타입이 없고,
// 그것을 넣으면 앱 코드에서도 fs·child_process 가 열린다 — 이 파일 하나 때문에 그럴 이유가 없다.
//
// 이 스크립트는 모바일의 모든 진입점(dev·release 빌드·테스트·타입검사) 앞단에 걸려 있다. 여기서
// 죽으면 dev 는 Metro 를 띄우기 전에 끝나고, 앱에는 "No script URL provided" 로 나타난다 —
// 원인과 증상이 멀어서 찾기 어렵다. 그래서 실제로 실행해 본다.

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(
  repoRoot,
  'apps',
  'mobile',
  'scripts',
  'prepare-runtime.cjs',
);
const webviewRoot = path.join(
  repoRoot,
  'packages',
  'fressh-react-native-xtermjs-webview',
);

function runPrepare(env) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

describe('prepare-runtime', () => {
  // 실제로 빌드가 돌면 몇 초 걸린다.
  jest.setTimeout(120_000);

  /**
   * npm 이 물려주는 환경 안에서도 서야 한다.
   *
   * 릴리즈와 dev 는 `npm run … --workspace @dolssh/mobile` 로 들어오고, 그러면 자식 프로세스에
   * npm_config_workspace 가 남는다. 이 스크립트가 빌드를 중첩 `npm run` 으로 부르던 동안에는 그
   * 값 때문에 npm 이 **모바일 워크스페이스**에서 스크립트를 찾다 "Missing script" 로 죽었다.
   * 지금은 vite 를 직접 부른다.
   */
  it('npm 워크스페이스 환경에서도 산출물을 만든다', () => {
    // 낡은 상태를 만든다 — 안 그러면 그냥 건너뛰어서 아무것도 확인하지 못한다.
    const now = new Date();
    fs.utimesSync(path.join(webviewRoot, 'src-internal', 'main.tsx'), now, now);

    const result = runPrepare({
      npm_config_workspace: '@dolssh/mobile',
      npm_lifecycle_event: 'build:android',
      npm_config_local_prefix: path.join(repoRoot, 'apps', 'mobile'),
    });

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(output).not.toContain('Missing script');
    expect(result.status).toBe(0);

    // 산출물이 실제로 생겼는지. 종료 코드만 보면 "건너뛰었다" 와 구분되지 않는다.
    for (const relative of [
      path.join('dist', 'index.js'),
      path.join('dist', 'index.d.ts'),
      path.join('dist-internal', 'index.html'),
    ]) {
      expect(fs.existsSync(path.join(webviewRoot, relative))).toBe(true);
    }
  });

  // 이 저장소가 페이지에 넣은 것(링크 애드온)이 산출물에 남아 있어야 한다. 소스가 아니라 게시된
  // 패키지에서 페이지를 가져오면 조용히 빠지고, 링크는 눌러도 아무 일도 일어나지 않는다.
  it('페이지를 이 저장소의 소스로 만든다', () => {
    const page = fs.readFileSync(
      path.join(webviewRoot, 'dist-internal', 'index.html'),
      'utf8',
    );
    expect(page).toContain('linkActivated');
  });

  it('바뀐 것이 없으면 다시 만들지 않는다', () => {
    const first = runPrepare({});
    expect(first.status).toBe(0);

    const second = runPrepare({});
    expect(second.status).toBe(0);
    // 다시 빌드하면 이 줄이 찍힌다. dev 를 켤 때마다 몇 초를 더 기다리게 된다.
    expect(`${second.stdout ?? ''}`).not.toContain('Preparing');
  });
});
