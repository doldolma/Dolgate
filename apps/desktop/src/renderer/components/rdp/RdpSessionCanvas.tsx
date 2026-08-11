import { useEffect, useRef, useState } from "react";
import type {
  RdpCertificatePrompt as RdpCertificatePromptData,
  RdpConnectedPayload,
  RdpSessionEvent,
} from "@shared";
import { cn } from "../../lib/cn";
import { useAppStore } from "../../store/appStore";
import { subscribeRdpEvents, trustRdpCertificate } from "../../services/desktop/rdp";
import type { RdpCanvasRegion } from "./canvas-region";
import { RdpCertificatePrompt } from "./RdpCertificatePrompt";
import { useRdpCanvas } from "./useRdpCanvas";
import { useRdpAudio } from "./useRdpAudio";
import { useRdpAutoResize } from "./useRdpAutoResize";
import { useRdpClipboard } from "./useRdpClipboard";
import { useRdpInput } from "./useRdpInput";
import { useRdpKeyboardCapture } from "./useRdpKeyboardCapture";
import { rdpKeyboardCaptureAttributes } from "../../lib/rdp-keyboard-focus";

interface RdpSessionCanvasProps {
  sessionId: string;
  /**
   * 이 pane 이 화면에 보이는지. 숨은 pane 은 언마운트되지 않고 CSS 로 가려지므로(터미널이
   * 스크롤백을 유지하는 방식과 같다) 프레임은 계속 들어온다. 숨은 동안에는 누적 버퍼만 갱신하고
   * 보이는 캔버스 칠하기를 건너뛴다.
   */
  visible?: boolean;
  // 이미 연결이 끝난 세션에 붙는 경우를 위해 외부에서 받을 수 있게 둔다.
  connected?: RdpConnectedPayload | null;
  /**
   * 이 창이 맡을 데스크톱의 일부. null 이면 전체를 그린다.
   *
   * 모니터마다 창을 띄울 때 각 창이 자기 몫만 그리게 한다. 좌표 환산도 이 원점을 따른다.
   */
  region?: RdpCanvasRegion | null;
  /** 이 창이 원격 해상도를 창 크기에 맞추게 할지. 모니터별 창에서는 배치가 고정이라 꺼야 한다. */
  autoResize?: boolean;
  /**
   * 이 창이 원격 소리를 낼지.
   *
   * 세션 하나에 창이 여럿이면 창마다 켜서는 안 된다. 각 창이 제 AudioContext 로 같은 PCM 을
   * 서로 다른 시각에 재생해서 메아리가 지고 소리가 겹쳐 커진다.
   */
  audio?: boolean;
  /** 로컬 → 원격 클립보드 전달. 호스트에서 끄면 false 다. */
  clipboard?: boolean;
}

// 원격 화면을 그리는 표면. 키보드·마우스 입력, 창 크기 연동, 클립보드(텍스트)를 함께 다룬다.
export function RdpSessionCanvas({
  sessionId,
  visible = true,
  connected,
  region: regionProp = null,
  autoResize = true,
  audio = true,
  clipboard = true,
}: RdpSessionCanvasProps) {
  const [desktop, setDesktop] = useState<RdpConnectedPayload | null>(connected ?? null);
  const [error, setError] = useState<string | null>(null);
  // 인증서 프롬프트는 스토어에 둔다 — 연결 오버레이가 그동안 자기를 내려야 하는데, 그쪽은 이
  // 컴포넌트의 형제라 로컬 state 를 볼 수 없다(store/types.ts 주석 참고).
  const certificatePrompt = useAppStore((state) => state.pendingRdpCertificatePrompt);
  const setCertificatePrompt = useAppStore(
    (state) => state.setPendingRdpCertificatePrompt,
  );
  // 모니터별로 펼쳤을 때 이 창이 맡은 영역. 메인 프로세스가 알려준다.
  const [assignedRegion, setAssignedRegion] =
    useState<RdpCanvasRegion | null>(null);

  useEffect(() => {
    setDesktop(connected ?? null);
  }, [connected]);

  useEffect(() => {
    return subscribeRdpEvents((event: RdpSessionEvent) => {
      if (event.sessionId !== sessionId) {
        return;
      }
      if (event.type === "certificatePrompt") {
        setCertificatePrompt(event.prompt);
      } else if (event.type === "connected") {
        setError(null);
        setCertificatePrompt(null);
        setDesktop(event.payload);
      } else if (event.type === "error") {
        setCertificatePrompt(null);
        setError(event.message);
      } else if (event.type === "resized") {
        // 해상도가 실제로 바뀌었다. 캔버스와 누적 버퍼가 새 크기로 다시 만들어진다.
        setDesktop((current) =>
          current
            ? {
                ...current,
                desktopWidth: event.desktopWidth,
                desktopHeight: event.desktopHeight,
                // 배치도 같이 옮긴다. 여기가 몇 개인지로 창 크기 자동 추종을 켜고 끄므로,
                // 원격이 배치를 단일 화면으로 되돌렸을 때 그걸 알아야 한다.
                monitors: event.monitors.length
                  ? event.monitors
                  : current.monitors,
              }
            : current,
        );
      } else if (event.type === "monitorRegion") {
        setAssignedRegion(event.region);
      } else if (event.type === "closed") {
        setDesktop(null);
        setAssignedRegion(null);
      }
    });
  }, [sessionId]);

  // 보조 창은 열릴 때 자기 영역을 프롭으로 받는다. 메인 창은 펼칠 때 이벤트로 받는다.
  const region = regionProp ?? assignedRegion;

  // 원시값으로 넘긴다. 객체로 넘기면 매 렌더마다 신원이 바뀌어 캔버스 크기를 다시 대입하게 되고,
  // 그 대입이 화면을 지운다.
  const { canvasRef } = useRdpCanvas(
    sessionId,
    desktop?.desktopWidth ?? null,
    desktop?.desktopHeight ?? null,
    visible,
    region,
  );

  const containerRef = useRef<HTMLDivElement | null>(null);

  // pane 이 보일 때만 따라간다. 숨은 pane 의 크기 변화까지 요청하면 보이지도 않는 화면 때문에
  // 원격이 재협상한다.
  //
  // 모니터가 여러 개면 아예 따라가지 않는다. 크기 요청은 DISP 채널의
  // encode_single_primary_monitor 로 나가서 모니터 하나짜리 레이아웃을 보낸다 — 3화면으로
  // 붙어도 첫 요청 한 번에 pane 크기의 1화면으로 접혀버린다. 접속 시 선언한 배치를 지키는 쪽이
  // 맞다. 여러 화면을 유지한 채 크기를 따라가려면 레이아웃 전체를 보내는 경로가 필요하다.
  const multiMonitor = (desktop?.monitors.length ?? 0) > 1;
  useRdpAutoResize(
    sessionId,
    containerRef,
    autoResize && visible && Boolean(desktop) && !multiMonitor,
  );

  // 숨은 pane 도 소리는 계속 낸다 — 다른 탭을 보는 동안 원격 알림이 들리는 편이 자연스럽다.
  useRdpAudio(sessionId, audio && Boolean(desktop));

  // 원격 → 로컬은 메인 프로세스가 처리한다. 여기서는 로컬 → 원격만 담당한다.
  useRdpClipboard(sessionId, canvasRef, clipboard && visible && Boolean(desktop));

  const { handlers } = useRdpInput({
    sessionId,
    // 영역을 맡았으면 그 크기가 곧 이 캔버스가 그리는 크기다.
    width: region ? region.width : (desktop?.desktopWidth ?? null),
    height: region ? region.height : (desktop?.desktopHeight ?? null),
    // 숨은 pane 은 입력을 받지 않는다 — 보이지도 않는 화면에 키가 들어가면 안 된다.
    enabled: visible && Boolean(desktop),
    surfaceRef: canvasRef,
    originX: region?.left ?? 0,
    originY: region?.top ?? 0,
    // 모니터마다 창을 펼친 상태에서는 이동을 화면 좌표로 보낸다. 버튼을 누른 채 드래그하면
    // OS 가 이후 이벤트를 처음 누른 창에만 보내서, 이 캔버스 기준으로는 옆 모니터를 표현할 수
    // 없다 — 창을 옆 화면으로 끌 수 없게 된다.
    useScreenCoordinates: Boolean(region),
  });

  // 포커스가 여기 있는 동안에는 우리 앱 단축키(Ctrl+Tab 등)를 메인이 비켜 준다. 안 그러면 그 키가
  // 캔버스에 닿지도 못하고 우리 탭만 넘어간다.
  const keyboardCapture = useRdpKeyboardCapture();

  return (
    // absolute inset-0 이어야 한다(TerminalSessionPane 도 같다). 단독 세션 탭에서는 감싸는 슬롯에
    // 크기 지정이 없어 h-full 이 auto 로 풀리고, 그러면 이 컨테이너의 높이가 캔버스에서 나온다.
    // 그 상태로 크기를 관찰하면 요청 → 캔버스 축소 → 컨테이너 축소 → 더 작은 요청으로 이어지는
    // 되먹임이 생겨, 창을 조절할 때마다 원격 화면이 조금씩 줄어든다.
    //
    // 숨은 pane 은 반드시 display:none 이어야 한다. absolute inset-0 인 채로 남겨두면 다른 탭을
    // 골라도 이 pane 이 그 위를 덮어, 탭을 눌러도 화면이 안 바뀐 것처럼 보인다. 언마운트하지 않는
    // 이유는 터미널과 같다 — 세션과 그동안 받은 화면을 살려둔다.
    <div
      ref={containerRef}
      className={cn(
        'absolute inset-0 items-center justify-center overflow-hidden bg-black',
        visible ? 'flex' : 'hidden',
      )}
    >
      {certificatePrompt ? (
        <RdpCertificatePrompt
          prompt={certificatePrompt}
          onDecide={(accept) => {
            setCertificatePrompt(null);
            void trustRdpCertificate(certificatePrompt.sessionId, accept);
          }}
        />
      ) : error ? (
        <div className="p-4 text-sm text-[var(--color-danger,#ef4444)]">{error}</div>
      ) : null}

      {/* 원격 해상도가 창보다 클 수 있어 비율을 유지한 채 맞춘다. tabIndex 가 있어야 키 이벤트가
          캔버스로 온다. outline 은 끄되 포커스 자체는 유지한다. 프롬프트·오류 중에는 캔버스를
          내리되 언마운트하지 않는다 — ref 가 끊기면 다시 붙었을 때 그릴 곳이 사라진다. */}
      <canvas
        ref={canvasRef}
        tabIndex={0}
        // 렌더러 안의 단축키 처리(capture 단계 리스너)가 "지금 원격이 키보드를 쥐었나" 를 이걸로
        // 판단한다. 상태를 따로 들지 않는 이유는 활성 요소가 곧 사실이라 어긋날 수 없기 때문이다.
        {...rdpKeyboardCaptureAttributes}
        className={cn(
          'max-h-full max-w-full object-contain outline-none',
          (certificatePrompt || error) && 'hidden',
        )}
        {...handlers}
        onFocus={keyboardCapture.onFocus}
        onBlur={() => {
          // 원래의 blur 처리(누르고 있던 키를 원격에서 떼어 주기)를 잃지 않게 같이 부른다.
          handlers.onBlur();
          keyboardCapture.onBlur();
        }}
      />
    </div>
  );
}
