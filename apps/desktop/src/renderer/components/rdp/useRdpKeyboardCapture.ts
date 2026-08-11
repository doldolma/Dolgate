import { useCallback, useEffect, useRef } from "react";
import { setRdpKeyboardCapture } from "../../services/desktop/rdp";

/**
 * 원격 화면에 포커스가 있는 동안 우리 앱 단축키를 비켜 달라고 메인에 알린다.
 *
 * 왜 메인에 알려야 하는가: 캔버스는 받은 키를 제대로 원격으로 보내는데, Ctrl+Tab 같은 키가 캔버스에
 * **도달하지 못한다.** Win/Linux 는 `before-input-event` 가 렌더러 도달 전에 가져가고, macOS 는 메뉴
 * accelerator 가 웹 페이지보다 먼저 매칭된다. 둘 다 메인 프로세스라 렌더러가 스스로 막을 수 없다.
 *
 * 그동안 Dolgate 자신의 탭은 키보드로 옮길 수 없다 — 마우스로 탭을 누르거나, 캔버스 밖을 한 번
 * 클릭해 포커스를 뺀 뒤 평소 단축키를 쓴다(제품 결정).
 */
export function useRdpKeyboardCapture(): {
  onFocus: () => void;
  onBlur: () => void;
} {
  // 지금 켜 둔 상태인지. 언마운트 때 켜져 있었으면 반드시 꺼야 한다.
  const activeRef = useRef(false);

  const apply = useCallback((active: boolean) => {
    if (activeRef.current === active) {
      return;
    }
    activeRef.current = active;
    setRdpKeyboardCapture(active);
  }, []);

  useEffect(() => {
    return () => {
      // 포커스를 쥔 채 세션이 끝나는 경우(탭 닫기·원격 로그오프·재연결로 교체)에는 blur 가 오지
      // 않는다. 여기서 끄지 않으면 앱 단축키가 영구히 죽는다.
      if (activeRef.current) {
        activeRef.current = false;
        setRdpKeyboardCapture(false);
      }
    };
  }, []);

  return {
    onFocus: useCallback(() => apply(true), [apply]),
    onBlur: useCallback(() => apply(false), [apply]),
  };
}
