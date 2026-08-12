// VNC 세션에서 실제로 켜진 확장을 sessionId 기준으로 보관하는 경량 레지스트리.
//
// terminal-cwd-registry 와 같은 결이다. store 에 두지 않는 이유도 같다 — 읽는 곳은 탭 hover 카드
// 하나뿐이고(그 카드는 마우스를 올린 순간에 그려진다), 협상 결과가 하나씩 드러날 때마다 전역
// 리렌더를 낼 이유가 없다.
//
// **선언과 다르다.** 코어는 늘 같은 인코딩 목록을 선언하지만 켜지는 것은 서버마다 다르고, 그것은
// 협상이 끝나 봐야 안다. 사용자에게 이걸 보여주는 것이 "왜 한글 복붙이 안 되지" 에 답하는 유일한
// 방법이다 — 서버가 UTF-8 클립보드를 지원하지 않으면 우리가 할 수 있는 일이 없다.

import type { VncCapabilities } from '@shared';

const capabilitiesBySessionId = new Map<string, VncCapabilities>();

export function setVncCapabilities(
  sessionId: string,
  capabilities: VncCapabilities,
): void {
  if (!sessionId) {
    return;
  }
  capabilitiesBySessionId.set(sessionId, capabilities);
}

export function getVncCapabilities(sessionId: string): VncCapabilities | null {
  return capabilitiesBySessionId.get(sessionId) ?? null;
}

/** 세션이 끝나면 지운다. 재연결이 같은 sessionId 를 다시 쓰므로 남겨 두면 옛 결과가 보인다. */
export function clearVncCapabilities(sessionId: string): void {
  capabilitiesBySessionId.delete(sessionId);
}
