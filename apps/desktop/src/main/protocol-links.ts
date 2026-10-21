/**
 * 앱이 OS 로부터 받는 주소.
 *
 * - `dolgate://auth/...` 는 로그인 콜백이다.
 * - `dolgate-invite://join?link=<초대 링크>` 는 서버의 링크 페이지가 `앱 열기` 로 넘긴 팀 초대다. 초대는 스킴을
 *   따로 둔다 — 지금까지 나간 앱은 `dolgate://` 로 온 것을 모두 로그인 콜백으로 읽고, 콜백이 아니면 세션을
 *   지운다. 같은 스킴으로 넘기면 옛 버전을 쓰는 사람이 링크를 누르는 순간 로그아웃된다. 새 스킴은 옛 앱이
 *   모르니 아무 일도 일어나지 않는다.
 * - 그 밖의 `dolgate://` 는 받지 않는다. 앞으로 생길 주소를 옛 앱처럼 로그인 콜백으로 잘못 읽지 않게.
 */
export const DOLGATE_SCHEME = "dolgate";
export const TEAM_INVITE_SCHEME = "dolgate-invite";
export const APP_URL_SCHEMES = [DOLGATE_SCHEME, TEAM_INVITE_SCHEME] as const;

export type ProtocolLink =
  | { kind: "auth-callback"; url: string }
  | { kind: "team-invite"; link: string }
  | { kind: "ignored" };

/** 실행 인자에서 앱 주소를 찾는다(윈도·리눅스는 주소를 인자로 넘긴다). */
export function findProtocolUrl(argv: readonly string[]): string | null {
  return argv.find((value) => APP_URL_SCHEMES.some((scheme) => value.startsWith(`${scheme}://`))) ?? null;
}

export function classifyProtocolUrl(raw: string): ProtocolLink {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "ignored" };
  }
  if (url.protocol === `${TEAM_INVITE_SCHEME}:`) {
    // 초대 링크(https://<서버>/invite/<번호>#v1.<비밀값>)는 통째로 link 에 담겨 온다 — # 뒤도 인코딩돼 있다.
    const link = url.searchParams.get("link")?.trim();
    return link ? { kind: "team-invite", link } : { kind: "ignored" };
  }
  if (url.protocol === `${DOLGATE_SCHEME}:` && url.hostname === "auth") {
    return { kind: "auth-callback", url: raw };
  }
  return { kind: "ignored" };
}
