import { useEffect, useRef, useState } from "react";
import type { RdpConnectedPayload, RdpSessionEvent } from "@shared";
import {
  describeRdpSession,
  requestRdpRefresh,
  subscribeRdpEvents,
} from "../../services/desktop/rdp";
import { RdpSessionCanvas } from "./RdpSessionCanvas";

interface RdpMonitorWindowProps {
  sessionId: string;
  /** 이 창이 맡은 원격 모니터의 번호. 접속 때 알려준 배치의 인덱스다. */
  monitorIndex: number;
}

/**
 * 원격 모니터 하나만 띄우는 전체화면 창.
 *
 * 프레임은 메인 프로세스가 모든 창에 뿌리므로, 이 창은 같은 세션을 구독해 제 몫만 잘라 그린다.
 * 세션을 따로 열지 않는다 — 창마다 접속하면 원격에 세션이 여러 개 생긴다.
 */
export function RdpMonitorWindow({
  sessionId,
  monitorIndex,
}: RdpMonitorWindowProps) {
  const [desktop, setDesktop] = useState<RdpConnectedPayload | null>(null);

  useEffect(() => {
    return subscribeRdpEvents((event: RdpSessionEvent) => {
      if (event.sessionId !== sessionId) {
        return;
      }
      if (event.type === "connected") {
        setDesktop(event.payload);
      } else if (event.type === "resized") {
        setDesktop((current) =>
          current
            ? {
                ...current,
                desktopWidth: event.desktopWidth,
                desktopHeight: event.desktopHeight,
              }
            : current,
        );
      } else if (event.type === "closed") {
        setDesktop(null);
      }
    });
  }, [sessionId]);

  // 이 창은 이미 붙어 있는 세션에 얹힌다. connected 이벤트는 우리가 열리기 전에 지나갔을 수
  // 있으므로 메인 프로세스에 지금 상태를 물어본다.
  useEffect(() => {
    let cancelled = false;
    void describeRdpSession(sessionId)
      .then((payload) => {
        if (!cancelled && payload) {
          setDesktop(payload);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // 이 창은 세션 도중에 열린다. RDP 는 바뀐 부분만 보내고 서버는 정지한 영역을 다시 보내주지
  // 않으므로, 한 번 통째로 받아오지 않으면 검은 화면에 마우스가 지나간 자리만 채워진다.
  //
  // 창당 딱 한 번이다. 이걸 창 등록마다 걸었더니 전체 프레임(수 MB)이 몰아쳐 화면이 초당 한두
  // 장으로 떨어지고 오디오까지 끊겼다.
  const askedRef = useRef(false);
  useEffect(() => {
    if (askedRef.current || !desktop) {
      return;
    }
    askedRef.current = true;
    requestRdpRefresh(sessionId);
  }, [sessionId, desktop]);

  const region = desktop?.monitors[monitorIndex] ?? null;

  if (!desktop || !region) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black text-[0.85rem] text-[#8ea0bd]">
        원격 화면을 기다리는 중…
      </div>
    );
  }

  return (
    <div className="relative h-screen w-screen bg-black">
      <RdpSessionCanvas
        sessionId={sessionId}
        connected={desktop}
        region={region}
        // 이 창의 크기로 원격 해상도를 바꾸면 안 된다. 배치는 접속 때 정해졌고, 크기 요청은
        // 모니터 하나짜리 레이아웃을 보내 전체 배치를 통째로 접어버린다.
        autoResize={false}
        // 소리는 메인 창 하나만 낸다. 창마다 켜면 같은 PCM 이 창 수만큼 서로 다른 시각에
        // 재생되어 메아리가 지고 소리가 겹쳐 커진다.
        audio={false}
      />
    </div>
  );
}
