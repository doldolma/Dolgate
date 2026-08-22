import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 데스크톱 환경은 실행 중인 창을 "설치된 바로가기/항목"에 식별자로 묶는다. 그 식별자가 앱이
// 선언하는 값과 설치 프로그램이 심는 값 사이에서 어긋나면, 짝을 찾지 못해 작업표시줄·도크
// 아이콘이 창 아이콘으로 떨어진다. 실제로 Windows 에서 그렇게 깨져 있었다.
//
// 두 값은 런타임 코드와 빌드 설정이라는 서로 다른 파일에 있어 조용히 어긋날 수 있다. 빌드
// 설정을 런타임에 import 하지 않으려고 소스를 읽어 비교한다.
function readSource(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, relativePath), 'utf8');
}

function extractCaptured(source: string, pattern: RegExp): string {
  const match = pattern.exec(source);
  if (!match?.[1]) {
    throw new Error(`값을 찾지 못했다: ${pattern}`);
  }
  return match[1];
}

// Windows: AppUserModelID ↔ 바로가기. 앱 쪽에는 Squirrel.Windows 규약
// ('com.squirrel.<name>.<exe>') 가 남아 있었는데 forge 의 makers 는 비어 있어 Squirrel 은
// 쓰이지 않고, 릴리스는 electron-builder NSIS 로 나간다 — 그래서 값이 어긋나 있었다.
describe('Windows AppUserModelID', () => {
  it('앱이 선언하는 값과 설치 프로그램의 appId 가 같다', () => {
    const appUserModelId = extractCaptured(
      readSource('main.ts'),
      /const WINDOWS_APP_USER_MODEL_ID = '([^']+)'/,
    );
    const appId = extractCaptured(
      readSource('../../electron-builder.config.cjs'),
      /appId:\s*'([^']+)'/,
    );

    expect(appUserModelId).toBe(appId);
  });

  it('쓰이지 않는 Squirrel 규약 값으로 되돌아가지 않는다', () => {
    const appUserModelId = extractCaptured(
      readSource('main.ts'),
      /const WINDOWS_APP_USER_MODEL_ID = '([^']+)'/,
    );

    expect(appUserModelId).not.toMatch(/^com\.squirrel\./);
  });
});

// Linux: .desktop 의 StartupWMClass ↔ 창의 WM_CLASS. Electron 은 package.json 의
// desktopName 을 app_id / WM_CLASS 로 쓰고, electron-builder 는 linux.syncDesktopName 이
// 켜져 있을 때만 같은 값에서 .desktop 파일명과 StartupWMClass 를 뽑는다. 꺼두면
// StartupWMClass 가 productName 으로 폴백해 어긋난다(electron-builder 가 빌드마다 경고한다).
describe('Linux 창 연결', () => {
  it('desktopName 이 executableName 과 같은 basename 을 쓴다', () => {
    const desktopName = extractCaptured(
      readSource('../../package.json'),
      /"desktopName":\s*"([^"]+)"/,
    );
    const executableName = extractCaptured(
      readSource('../../electron-builder.config.cjs'),
      /executableName:\s*'([^']+)'/,
    );

    // 같아야 .desktop 파일명이 바뀌지 않는다 — 기존 설치본에서 올라올 때 항목이 둘로
    // 늘지 않는다는 뜻이다.
    expect(desktopName.replace(/\.desktop$/, '')).toBe(executableName);
  });

  it('syncDesktopName 이 켜져 있다', () => {
    const config = readSource('../../electron-builder.config.cjs');

    expect(config).toMatch(/syncDesktopName:\s*true/);
  });
});
