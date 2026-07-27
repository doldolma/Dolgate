const ROOT_PATHNAME = '/';

// 검증 결과는 코드로 돌려준다 — 문구와 번역 키는 각 앱이 자기 카탈로그로 만든다.
// 여기서 완성된 문장을 돌려주면 공용 패키지가 UI 언어를 결정해 버려, 데스크톱과 모바일이
// 서로 다른 언어를 쓸 수 없다.
export type ServerUrlIssue =
  | 'empty'
  | 'not-absolute'
  | 'bad-scheme'
  | 'has-path'
  | 'has-query';

export function getServerUrlIssue(value: string): ServerUrlIssue | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'empty';
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'not-absolute';
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'bad-scheme';
  }

  if (parsed.pathname && parsed.pathname !== ROOT_PATHNAME) {
    return 'has-path';
  }

  if (parsed.search || parsed.hash) {
    return 'has-query';
  }

  return null;
}

export function normalizeServerUrl(value: string): string {
  return new URL(value.trim()).origin;
}
