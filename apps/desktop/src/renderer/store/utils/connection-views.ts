import type { TerminalConnectionHop } from "@shared";
import type { ConnectionView } from "../types";

/**
 * 연결 하나가 지금 어디까지 갔는지. **경로를 가리지 않고** 상관 ID 로만 모은다.
 *
 * **왜 필요한가:** 코어는 세션·SFTP·컨테이너·포워딩·공개키 설치에 대해 똑같은 이벤트를 올린다
 * (홉 진행, 배너, 신뢰 질의, 대화형 인증). 그런데 화면 쪽은 그것을 받는 자리가 경로마다 따로였고,
 * 자리가 없는 경로는 그냥 버렸다 — 포워딩을 시작하면 tailnet 도 점프도 아무것도 안 보이던 이유가
 * 이것이다. 한 곳에 모아 두면 어느 화면이든 같은 것을 그릴 수 있다.
 *
 * 터미널·SFTP·컨테이너는 자기 상태(탭·판)에 이미 홉을 들고 있다. 그쪽을 걷어내지 않는 이유는
 * 그 화면들이 홉 말고도 자기 것을 함께 그리기 때문이고, 여기 있는 값과 어긋나지 않는다 — 같은
 * 이벤트에서 같은 규칙으로 채운다.
 */
export const CONNECTION_VIEW_LIMIT = 32;

/** 홉 하나를 끼워 넣는다. 같은 번호가 다시 오면 갈아 끼운다(connecting → connected). */
export function upsertConnectionHop(
  existing: readonly TerminalConnectionHop[] | undefined,
  hop: TerminalConnectionHop,
): TerminalConnectionHop[] {
  // 1 번 홉이 connecting 으로 다시 오면 새 시도다 — 앞 시도의 홉을 남기면 실패한 경로가 그대로
  // 붙어 있어서 "어디까지 갔나" 를 잘못 읽게 된다.
  const base =
    hop.index === 1 && hop.stage === "connecting" ? [] : (existing ?? []);
  const at = base.findIndex((item) => item.index === hop.index);
  return at >= 0
    ? base.map((item, index) => (index === at ? hop : item))
    : [...base, hop];
}

/** 이 연결의 뷰를 만들거나 갱신한다. */
export function updateConnectionView(
  views: Record<string, ConnectionView>,
  key: string,
  patch: Partial<ConnectionView>,
): Record<string, ConnectionView> {
  const current: ConnectionView = views?.[key] ?? {
    key,
    status: "connecting",
    hops: [],
  };
  const next: Record<string, ConnectionView> = {
    ...(views ?? {}),
    [key]: { ...current, ...patch, key },
  };
  return pruneConnectionViews(next);
}

/** 끝난 연결의 뷰를 지운다. */
export function clearConnectionView(
  views: Record<string, ConnectionView>,
  key: string,
): Record<string, ConnectionView> {
  if (!(key in views)) {
    return views;
  }
  const next = { ...views };
  delete next[key];
  return next;
}

/**
 * 뷰가 무한히 쌓이지 않게 한다.
 *
 * 정상 경로는 끝날 때 지워지지만, 어떤 실패는 끝을 알리는 이벤트 없이 사라진다(코어가 죽거나
 * 프레임이 유실되는 경우). 그것이 누적되면 오래 켜 둔 앱에서 메모리가 계속 는다.
 */
function pruneConnectionViews(
  views: Record<string, ConnectionView>,
): Record<string, ConnectionView> {
  const keys = Object.keys(views);
  if (keys.length <= CONNECTION_VIEW_LIMIT) {
    return views;
  }
  const next = { ...views };
  for (const key of keys.slice(0, keys.length - CONNECTION_VIEW_LIMIT)) {
    delete next[key];
  }
  return next;
}
