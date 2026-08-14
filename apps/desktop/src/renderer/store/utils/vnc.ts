/**
 * VNC 세션이 쓰는 SSH 터널의 상관 ID 규칙.
 *
 * VNC 화면은 vnc-core 가 그리지만 경유 터널은 ssh-core 가 연다(`ipc/vnc.ts` 의 `openForward`).
 * 그 터널은 사용자가 만든 포워딩 규칙이 아니라 세션에 딸린 것이므로, 메인이 `vnc:<sessionId>` 를
 * 규칙 ID 로 지어서 세션과 묶는다. 코어가 그 터널에 대해 올리는 질문(OTP·호스트 키)은 이 ID 를
 * 달고 오므로, 화면이 그것을 어느 VNC 탭에 그릴지 알려면 여기서 다시 세션을 꺼내야 한다.
 *
 * 규칙 ID 형식의 주인은 메인이다(`ipc/vnc.ts`). 한쪽만 바꾸면 카드가 다시 사라지므로 양쪽에 서로를
 * 가리키는 주석을 둔다. 컨테이너도 같은 방식이다(`resolveContainersHostIdByEndpoint`).
 */
const VNC_TUNNEL_ENDPOINT_PREFIX = "vnc:";

/** 이 엔드포인트가 VNC 세션의 터널이면 그 세션 ID. 아니면 null. */
export function resolveVncTunnelSessionId(
  endpointId: string | null | undefined,
): string | null {
  if (!endpointId || !endpointId.startsWith(VNC_TUNNEL_ENDPOINT_PREFIX)) {
    return null;
  }
  const sessionId = endpointId.slice(VNC_TUNNEL_ENDPOINT_PREFIX.length).trim();
  return sessionId || null;
}
