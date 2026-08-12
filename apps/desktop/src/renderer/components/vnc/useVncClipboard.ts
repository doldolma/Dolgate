import { useEffect } from "react";
import { syncVncClipboard } from "../../services/desktop/vnc";

/**
 * 로컬에서 복사한 텍스트를 원격이 붙여넣을 수 있게 미리 올린다.
 *
 * 원격 → 로컬 방향은 메인 프로세스가 처리한다(클립보드를 소유하는 쪽이라). 이 훅은 반대편만
 * 담당하고, 실제 읽기도 메인이 한다 — 렌더러는 "지금 올려라" 는 신호만 보낸다.
 *
 * **붙여넣는 순간에 읽지 않는 이유는 RDP 와 같다:**
 *
 * 1. 키를 원격으로 보내려면 keydown 에서 preventDefault 를 해야 하는데, 그러면 브라우저가 paste
 *    이벤트를 만들지 않는다. 붙여넣기를 감지할 방법 자체가 없어진다.
 * 2. 그 순간에 올려 봐야 늦다 — 사용자의 Ctrl+V 는 이미 원격에 도착해 있다.
 *
 * 그래서 화면에 포커스가 갈 때(= 사용자가 원격을 쓰기 시작하는 시점) 미리 올려 둔다.
 *
 * 고전 RFB 클립보드는 latin-1 만 실을 수 있어서 한글은 `?` 로 바뀐다(vnc-core 의
 * write_client_cut_text 참고). UTF-8 은 ExtendedClipboard 의사 인코딩이 있어야 하고 그건 별건이다.
 */
export function useVncClipboard(
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
      syncVncClipboard(sessionId);
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
