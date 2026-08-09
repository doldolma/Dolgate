import { useEffect } from "react";
import { syncRdpClipboard } from "../../services/desktop/rdp";

/**
 * 로컬에서 복사한 텍스트를 원격이 붙여넣을 수 있게 미리 올린다.
 *
 * 원격 → 로컬 방향은 메인 프로세스가 처리한다(클립보드를 소유하는 쪽이라). 이 훅은 반대편만
 * 담당하고, 실제 읽기도 메인이 한다 — 렌더러는 "지금 올려라"는 신호만 보낸다.
 *
 * 붙여넣는 순간에 읽지 않는 이유가 둘 있다:
 *
 * 1. 키 입력을 원격으로 보내려면 keydown 에서 preventDefault 를 해야 하는데, 그러면 브라우저가
 *    paste 이벤트를 만들지 않는다. 붙여넣기를 감지할 방법 자체가 없어진다.
 * 2. 붙여넣는 순간에 알려 봐야 늦다. 서버는 알림을 받고 나서 데이터를 요청하는데, 사용자의
 *    Ctrl+V 는 이미 그 전에 도착해 있다.
 *
 * 그래서 화면에 포커스가 갈 때 — 사용자가 원격을 쓰기 시작하는 시점에 — 미리 올려 둔다.
 */
export function useRdpClipboard(
  sessionId: string,
  surfaceRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!enabled || !surface) {
      return;
    }

    const push = () => {
      syncRdpClipboard(sessionId);
    };

    // 앱 밖에서 복사하고 돌아오는 흐름이 가장 흔하므로 창 포커스도 함께 본다.
    surface.addEventListener("focus", push);
    window.addEventListener("focus", push);

    // 이미 포커스를 쥔 채로 마운트되는 경우(탭 전환 복귀)를 위해 한 번 올린다.
    push();

    return () => {
      surface.removeEventListener("focus", push);
      window.removeEventListener("focus", push);
    };
  }, [sessionId, surfaceRef, enabled]);
}
