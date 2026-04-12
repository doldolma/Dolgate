const ROOT_PATHNAME = '/';

export function getServerUrlValidationMessage(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return '로그인 서버 주소를 입력해 주세요.';
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '로그인 서버 주소는 http:// 또는 https:// 로 시작하는 절대 URL이어야 합니다.';
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return '로그인 서버 주소는 http:// 또는 https:// 로 시작해야 합니다.';
  }

  if (parsed.pathname && parsed.pathname !== ROOT_PATHNAME) {
    return '로그인 서버 주소에는 경로를 포함할 수 없습니다.';
  }

  if (parsed.search || parsed.hash) {
    return '로그인 서버 주소에는 쿼리나 해시를 포함할 수 없습니다.';
  }

  return null;
}

export function normalizeServerUrl(value: string): string {
  return new URL(value.trim()).origin;
}
