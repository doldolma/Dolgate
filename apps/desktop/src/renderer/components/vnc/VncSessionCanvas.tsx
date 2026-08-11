import { useEffect, useRef, useState } from 'react';
import type { VncConnectedPayload, VncInputEvent, VncSessionEvent } from '@shared';

import { cn } from '../../lib/cn';
import { subscribeVncEvents, sendVncInput } from '../../services/desktop/vnc';
import { keysymFromEvent, keysymsFromComposedText } from './keysym';
import { useVncCanvas } from './useVncCanvas';

interface VncSessionCanvasProps {
  sessionId: string;
  /**
   * 이 pane 이 화면에 보이는지. 숨은 pane 은 언마운트되지 않고 CSS 로 가려지므로(터미널이
   * 스크롤백을 유지하는 방식과 같다) 프레임은 계속 들어온다.
   */
  visible?: boolean;
  /** 이미 붙은 세션에 뒤늦게 붙는 경우를 위해 외부에서 받을 수 있게 둔다. */
  connected?: VncConnectedPayload | null;
  /** 화면만 보고 입력은 보내지 않는다. 운영 중인 콘솔을 실수로 클릭하는 것을 막는 용도다. */
  viewOnly?: boolean;
}

/** 원격 데스크톱 좌표로 환산한다. 캔버스는 비율을 유지한 채 축소돼 있을 수 있다. */
function toDesktopPoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }
  const x = ((clientX - rect.left) / rect.width) * canvas.width;
  const y = ((clientY - rect.top) / rect.height) * canvas.height;
  // 경계를 넘는 값을 보내면 서버가 화면 밖 좌표로 본다. 가장자리로 물린다.
  return {
    x: Math.max(0, Math.min(canvas.width - 1, Math.round(x))),
    y: Math.max(0, Math.min(canvas.height - 1, Math.round(y))),
  };
}

export function VncSessionCanvas({
  sessionId,
  visible = true,
  connected,
  viewOnly = false,
}: VncSessionCanvasProps) {
  const [desktop, setDesktop] = useState<VncConnectedPayload | null>(connected ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDesktop(connected ?? null);
  }, [connected]);

  useEffect(() => {
    return subscribeVncEvents((event: VncSessionEvent) => {
      if (event.sessionId !== sessionId) {
        return;
      }
      if (event.type === 'connected') {
        setError(null);
        setDesktop(event.payload);
      } else if (event.type === 'resized') {
        // VM 콘솔은 부팅 중에 해상도가 여러 번 바뀐다(BIOS → 부트로더 → OS).
        setDesktop((current) =>
          current
            ? {
                ...current,
                desktopWidth: event.desktopWidth,
                desktopHeight: event.desktopHeight,
              }
            : current,
        );
      } else if (event.type === 'error') {
        setError(event.message);
      } else if (event.type === 'closed') {
        setDesktop(null);
      }
    });
  }, [sessionId]);

  const { canvasRef } = useVncCanvas(
    sessionId,
    desktop?.desktopWidth ?? null,
    desktop?.desktopHeight ?? null,
    visible,
  );

  // 입력을 보낼 수 있는 상태인지. 숨은 pane 과 view-only 는 보내지 않는다.
  const inputEnabled = visible && !viewOnly && Boolean(desktop);
  const inputEnabledRef = useRef(inputEnabled);
  inputEnabledRef.current = inputEnabled;

  const send = (events: VncInputEvent[]) => {
    if (!inputEnabledRef.current || events.length === 0) {
      return;
    }
    sendVncInput(sessionId, events);
  };

  const pointerFrom = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }
    return toDesktopPoint(canvas, event.clientX, event.clientY);
  };

  return (
    // absolute inset-0 이어야 한다(TerminalSessionPane·RdpSessionCanvas 와 같은 이유). 단독 탭에서는
    // 감싸는 슬롯에 크기 지정이 없어 h-full 이 auto 로 풀리고, 그 상태로 크기를 관찰하면 되먹임이
    // 생긴다.
    //
    // 숨은 pane 은 display:none 이어야 한다. absolute inset-0 인 채로 남겨두면 다른 탭을 골라도
    // 이 pane 이 그 위를 덮는다.
    <div
      className={cn(
        'absolute inset-0 items-center justify-center overflow-hidden bg-black',
        visible ? 'flex' : 'hidden',
      )}
    >
      {error ? (
        <div className="p-4 text-sm text-[var(--color-danger,#ef4444)]">{error}</div>
      ) : null}

      {/* 원격 해상도가 창보다 클 수 있어 비율을 유지한 채 맞춘다. tabIndex 가 있어야 키 이벤트가
          캔버스로 온다. 오류 중에는 캔버스를 내리되 언마운트하지 않는다 — ref 가 끊기면 다시
          붙었을 때 그릴 곳이 사라진다. */}
      <canvas
        ref={canvasRef}
        tabIndex={0}
        className={cn(
          'max-h-full max-w-full object-contain outline-none',
          error && 'hidden',
        )}
        onMouseMove={(event) => {
          const point = pointerFrom(event);
          if (point) {
            send([{ kind: 'mouseMove', x: point.x, y: point.y }]);
          }
        }}
        onMouseDown={(event) => {
          // 캔버스가 포커스를 받아야 키 이벤트가 온다.
          event.currentTarget.focus();
          const point = pointerFrom(event);
          if (point) {
            send([
              { kind: 'mouseButton', button: event.button, pressed: true, x: point.x, y: point.y },
            ]);
          }
        }}
        onMouseUp={(event) => {
          const point = pointerFrom(event);
          if (point) {
            send([
              { kind: 'mouseButton', button: event.button, pressed: false, x: point.x, y: point.y },
            ]);
          }
        }}
        onMouseLeave={(event) => {
          // 눌린 버튼을 남겨 두면 원격이 계속 드래그 중으로 본다. 세 버튼을 모두 떼어 준다.
          const point = pointerFrom(event);
          if (!point) {
            return;
          }
          send(
            [0, 1, 2].map((button) => ({
              kind: 'mouseButton' as const,
              button,
              pressed: false,
              x: point.x,
              y: point.y,
            })),
          );
        }}
        onContextMenu={(event) => {
          // 오른쪽 클릭은 원격으로 보낸다. 로컬 메뉴가 뜨면 원격 메뉴를 쓸 수 없다.
          event.preventDefault();
        }}
        onWheel={(event) => {
          const point = pointerFrom(event);
          if (!point) {
            return;
          }
          event.preventDefault();
          const events: VncInputEvent[] = [];
          if (event.deltaY !== 0) {
            // 화면 좌표계는 아래가 양수, 휠 버튼은 위가 4번이다 — 부호를 뒤집는다.
            events.push({ kind: 'wheel', vertical: true, delta: -event.deltaY, x: point.x, y: point.y });
          }
          if (event.deltaX !== 0) {
            events.push({ kind: 'wheel', vertical: false, delta: event.deltaX, x: point.x, y: point.y });
          }
          send(events);
        }}
        onKeyDown={(event) => {
          const keysym = keysymFromEvent(event);
          if (keysym === null) {
            // IME 조합 중이거나 우리가 모르는 키다. 기본 동작만 막지 않는다.
            return;
          }
          // 원격이 키를 받으므로 브라우저 기본 동작(탭 이동·검색 등)은 막는다.
          event.preventDefault();
          send([{ kind: 'key', keysym, pressed: true }]);
        }}
        onKeyUp={(event) => {
          const keysym = keysymFromEvent(event);
          if (keysym === null) {
            return;
          }
          event.preventDefault();
          send([{ kind: 'key', keysym, pressed: false }]);
        }}
        onCompositionEnd={(event) => {
          // 한글 등 조합 입력. 조합 중에는 아무것도 보내지 않고(keysym.ts), 완성된 글자만 여기서
          // 눌렀다 떼어 보낸다 — 그러지 않으면 원격에 자모가 그대로 찍힌다.
          const events: VncInputEvent[] = [];
          for (const keysym of keysymsFromComposedText(event.data)) {
            events.push({ kind: 'key', keysym, pressed: true });
            events.push({ kind: 'key', keysym, pressed: false });
          }
          send(events);
        }}
        onBlur={() => {
          // 포커스를 잃을 때 눌려 있던 조합 키를 떼어 준다. 안 그러면 원격이 Shift 를 계속 눌린
          // 것으로 보고 그 뒤 입력이 전부 대문자가 된다.
          send(
            [0xffe1, 0xffe2, 0xffe3, 0xffe4, 0xffe9, 0xfe03, 0xffeb, 0xffec].map((keysym) => ({
              kind: 'key' as const,
              keysym,
              pressed: false,
            })),
          );
        }}
      />
    </div>
  );
}
