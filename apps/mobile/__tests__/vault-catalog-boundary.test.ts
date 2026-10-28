// 모바일 tsconfig 는 node 타입을 싣지 않는다(앱 코드가 node 것을 쓰면 걸리게). 쓰는 것만 적어 jest 로 받는다.
interface NodeFs {
  readdirSync(dir: string): string[];
  readFileSync(file: string, encoding: 'utf8'): string;
  statSync(file: string): { isDirectory(): boolean };
}
interface NodePath {
  basename(file: string): string;
  dirname(file: string): string;
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
  resolve(...parts: string[]): string;
}
const { readdirSync, readFileSync, statSync } =
  jest.requireActual<NodeFs>('fs');
const path = jest.requireActual<NodePath>('path');

/**
 * 스토어의 `hosts`·`secretsByRef`·`knownHosts`·`awsProfiles`·`tailnets`·`snippets` 는 개인 볼트의 것이다.
 * 팀 호스트도 찾아야 하는 곳(접속·세션·요청 창·점프·tailnet 판정·호스트 키 확인)이 그것을 날로 찾으면 팀
 * 호스트를 '없는 호스트'로 본다 — 그래서 찾기는 `src/store/vault-catalog.ts` 한 곳으로 모았고, 여기서 지킨다.
 * 개인 동기화·저장·개인 편집은 목록을 통째로 다루므로 찾기가 아니다(아래 규칙에 걸리지 않는다). 개인 편집이
 * 하나를 찾을 때는 `findPersonalHost`·`findPersonalSecret` 처럼 '개인 것만'을 이름으로 드러낸다.
 */

// 앱 뿌리(apps/mobile). node 전역(__dirname)도 없으므로 jest 가 아는 시험 파일 자리에서 잡는다.
function mobileRoot(): string {
  const testPath = expect.getState().testPath;
  if (!testPath) {
    throw new Error('시험 파일 자리를 알 수 없다');
  }
  return path.resolve(path.dirname(testPath), '..');
}

function srcDir(): string {
  return path.join(mobileRoot(), 'src');
}

// 찾기의 입구 자신.
function catalogPath(): string {
  return path.join(srcDir(), 'store', 'vault-catalog.ts');
}

// 지키는 곳: 스토어와 화면. lib 의 순수 함수는 목록을 인자로 받으므로 그것을 넘기는 쪽(여기)을 본다.
const GUARDED_DIRS = ['store', 'screens', 'components', 'hooks', 'navigation'];

// 개인 볼트만 다루는 화면 — 호스트 폼은 개인 호스트를 고치고(점프·터널 고르기도 같은 볼트다), 설정 목록은
// 개인 것을 관리한다. 팀 호스트는 폰에서 고치지 않는다.
const PERSONAL_SCREENS = new Set([
  'HostFormScreen.tsx',
  'RemoteDesktopHostFormScreen.tsx',
  'SettingsScreen.tsx',
]);

// 목록을 받아 그 안에서 찾는 함수들. 스토어의 날 목록을 넘기면 팀 볼트 것을 못 본다.
const LOOKUP_CALLS = [
  'resolveSshHostTailnetId',
  'formatInteractiveHop',
  'getKnownHostStatus',
  'findExistingQuickSshHost',
  'buildQuickSshHostLabel',
  'resolveSyncedTailnetRoute',
  'startSyncedTailnet',
  'resolveAwsSessionForHost',
  'resolveStartupCommand',
];

const RAW_FIELD =
  /(?:get\(\)|\bstate|\bcurrent\w*|\blocalState|\bs)\s*\.\s*(hosts|knownHosts|tailnets|awsProfiles|snippets|secretsByRef)\b/;

const RULES: Array<{ name: string; pattern: RegExp }> = [
  {
    name: '호스트를 날로 찾음',
    pattern: /\.\s*hosts\s*\.\s*(?:find|findIndex|findLast|some)\s*\(/g,
  },
  { name: '비밀값을 날로 찾음', pattern: /\.\s*secretsByRef\s*\[/g },
  {
    name: '호스트 키·AWS·tailnet·스니펫을 날로 찾음',
    pattern:
      /\.\s*(?:knownHosts|awsProfiles|tailnets|snippets)\s*\.\s*(?:find|findIndex|findLast|some|filter)\s*\(/g,
  },
];

function collectSources(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    if (statSync(fullPath).isDirectory()) {
      found.push(...collectSources(fullPath));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      found.push(fullPath);
    }
  }
  return found;
}

function guardedSources(): string[] {
  const catalog = catalogPath();
  return GUARDED_DIRS.flatMap(dir =>
    collectSources(path.join(srcDir(), dir)),
  ).filter(file => file !== catalog);
}

/** 주석 줄과 줄 끝 주석을 비운다(줄 번호는 그대로) — 주석 속 코드 언급에 걸리지 않게. */
function stripComments(content: string): string {
  return content
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trimStart();
      if (
        trimmed.startsWith('//') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('*')
      ) {
        return '';
      }
      const trailing = line.search(/\s\/\/\s/);
      return trailing >= 0 ? line.slice(0, trailing) : line;
    })
    .join('\n');
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function relative(file: string): string {
  return path.relative(mobileRoot(), file);
}

/** `name(` 의 인자 글(짝 맞는 괄호까지). 문자열 안의 괄호는 건너뛴다. */
function callArguments(code: string, openIndex: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let index = openIndex; index < code.length; index += 1) {
    const char = code[index];
    if (quote) {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return code.slice(openIndex + 1, index);
      }
    }
  }
  return code.slice(openIndex + 1);
}

describe('vault-catalog boundary', () => {
  it('스토어와 화면은 호스트·비밀값·호스트 키·AWS·tailnet·스니펫을 날로 찾지 않는다', () => {
    const violations: string[] = [];
    for (const file of guardedSources()) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const rule of RULES) {
        for (const match of code.matchAll(rule.pattern)) {
          violations.push(
            `${relative(file)}:${lineOf(code, match.index ?? 0)} ${rule.name}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('찾는 함수에 스토어의 날 목록을 넘기지 않는다', () => {
    const violations: string[] = [];
    for (const file of guardedSources()) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const name of LOOKUP_CALLS) {
        const call = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, 'g');
        for (const match of code.matchAll(call)) {
          const open = (match.index ?? 0) + match[0].length - 1;
          const raw = callArguments(code, open).match(RAW_FIELD);
          if (raw) {
            violations.push(
              `${relative(file)}:${lineOf(code, match.index ?? 0)} ${name} 에 ${
                raw[0]
              }`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('개인 화면이 아니면 호스트 목록을 날로 고르지 않는다', () => {
    const selector =
      /useMobileAppStore\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\s*\.\s*hosts\b/g;
    const violations: string[] = [];
    for (const file of guardedSources()) {
      if (PERSONAL_SCREENS.has(path.basename(file))) {
        continue;
      }
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const match of code.matchAll(selector)) {
        violations.push(`${relative(file)}:${lineOf(code, match.index ?? 0)}`);
      }
    }
    expect(violations).toEqual([]);
  });

  // 팀 칸은 팀 받기(team-sync.ts)가 쓰고 찾기 입구가 읽는다. 다른 곳이 날로 읽으면 볼트 규칙(그 볼트 안에서만·
  // 개인이 이긴다)을 건너뛰고, 개인 쪽 코드가 팀 것을 섞을 길이 생긴다.
  it('팀 칸은 팀 받기와 찾기 입구만 읽는다', () => {
    const allowed = new Set(['team-sync.ts']);
    const pattern = /\.\s*(?:teamVaults|teamSecrets)\b/g;
    const violations: string[] = [];
    for (const file of guardedSources()) {
      if (allowed.has(path.basename(file))) {
        continue;
      }
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const match of code.matchAll(pattern)) {
        violations.push(`${relative(file)}:${lineOf(code, match.index ?? 0)}`);
      }
    }
    expect(violations).toEqual([]);
  });

  // 위 규칙이 헛돌지 않는지 — 지키는 함수가 소스에 실제로 있어야 한다. 이름이 바뀌면 목록도 고친다.
  it('지키는 찾는 함수가 소스에 실제로 쓰인다', () => {
    const code = guardedSources()
      .map(file => stripComments(readFileSync(file, 'utf8')))
      .join('\n');
    const missing = LOOKUP_CALLS.filter(
      name => !new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(code),
    );
    expect(missing).toEqual([]);
  });
});
