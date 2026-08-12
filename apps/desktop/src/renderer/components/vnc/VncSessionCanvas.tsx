import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VncConnectedPayload, VncInputEvent, VncSessionEvent } from '@shared';

import { cn } from '../../lib/cn';
import { createWheelAccumulator, takeWheelNotches } from '../../lib/wheel';
import {
  clearVncCapabilities,
  setVncCapabilities,
} from '../../lib/vnc-capability-registry';
import { subscribeVncEvents, sendVncInput } from '../../services/desktop/vnc';
import { scancodeFor } from '../rdp/scancodes';
import { keysymFromEvent, keysymsFromComposedText } from './keysym';
import { useVncCanvas } from './useVncCanvas';
import { useVncAutoResize } from './useVncAutoResize';
import { useVncClipboard } from './useVncClipboard';
import { useVncCursor } from './useVncCursor';

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
  const { t: translate } = useTranslation();
  const [desktop, setDesktop] = useState<VncConnectedPayload | null>(connected ?? null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 클립보드가 깎여 나갔다는 알림. 잠깐 띄우고 사라진다.
   *
   * 서버가 UTF-8 확장을 지원하지 않으면 한글이 `?` 가 되는데, 그것을 말해 주지 않으면 사용자는
   * 원격의 `?` 만 보고 이유를 알 수 없다(탭 hover 에도 같은 사실이 있지만 복사하는 순간에는 안
   * 보인다). 세션을 막지 않도록 배너로 띄우고 스스로 사라지게 한다.
   */
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);

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
      } else if (event.type === 'capabilities') {
        // 협상 결과는 화면에 직접 쓰지 않고 레지스트리에만 남긴다 — 읽는 곳은 탭 hover 하나이고,
        // state 로 들고 있으면 확장 하나가 켜질 때마다 캔버스가 다시 그려진다.
        setVncCapabilities(sessionId, event.payload);
      } else if (event.type === 'clipboardLossy') {
        setClipboardNotice(
          translate('vnc.clipboardLossy', { count: event.replaced }),
        );
      } else if (event.type === 'error') {
        setError(event.message);
      } else if (event.type === 'closed') {
        setDesktop(null);
        clearVncCapabilities(sessionId);
      }
    });
  }, [sessionId, translate]);

  // 알림은 스스로 사라진다. 닫기 버튼을 두면 그것을 누르는 일이 하나 더 늘고, 이 알림은 조치를
  // 요구하지 않는다(서버가 못 하는 것이라 사용자가 할 수 있는 일이 없다).
  useEffect(() => {
    if (!clipboardNotice) {
      return;
    }
    const timer = window.setTimeout(() => setClipboardNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [clipboardNotice]);

  const { canvasRef } = useVncCanvas(
    sessionId,
    desktop?.desktopWidth ?? null,
    desktop?.desktopHeight ?? null,
    visible,
  );

  // pane 크기에 맞춰 원격 화면 크기를 따라가게 한다. 서버가 못 하면 코어가 조용히 버린다.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useVncAutoResize(sessionId, containerRef, visible && Boolean(desktop));

  // 로컬 클립보드를 미리 올려 둔다. view-only 여도 올린다 — 보기 전용은 **우리 입력**을 막는
  // 것이고, 원격에서 우리 클립보드를 붙여넣는 것은 원격 사용자의 일이다.
  useVncClipboard(sessionId, canvasRef, visible && Boolean(desktop));

  // 원격 커서 모양을 캔버스의 CSS 커서로 붙인다. 코어가 커서 의사 인코딩을 선언했으므로 서버는
  // 커서를 화면에 그려 주지 않는다 — 이게 없으면 포인터가 어디 있는지 보이지 않는다.
  // view-only 여도 붙인다: 모양은 보는 것이고, 막는 것은 입력이다.
  useVncCursor(sessionId, canvasRef, visible && Boolean(desktop));

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

  // 소수 노치를 모아 둔다. RFB 의 휠은 버튼 누름이라 "몇 칸" 만 의미가 있고, 브라우저가 주는
  // deltaY 는 소수다 — 그대로 보내면 코어가 정수를 기대하다 **묶음 전체를 버린다**(실제로 스크롤이
  // 하나도 전달되지 않았다).
  const wheelRef = useRef(createWheelAccumulator());

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
      ref={containerRef}
      className={cn(
        'absolute inset-0 items-center justify-center overflow-hidden bg-black',
        visible ? 'flex' : 'hidden',
      )}
    >
      {error ? (
        <div className="p-4 text-sm text-[var(--color-danger,#ef4444)]">{error}</div>
      ) : null}

      {clipboardNotice ? (
        <div
          data-testid="vnc-clipboard-notice"
          className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-[8px] bg-[rgba(0,0,0,0.78)] px-3 py-2 text-[0.85rem] text-white shadow-[var(--shadow-floating)]"
        >
          {clipboardNotice}
        </div>
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
          const notches = takeWheelNotches(wheelRef.current, event);
          const events: VncInputEvent[] = [];
          // 노치 하나가 버튼 한 번이다. 여러 칸이면 그만큼 반복해서 보낸다.
          for (let step = 0; step < Math.abs(notches.vertical); step += 1) {
            // 화면 좌표계는 아래가 양수, 휠 버튼은 위가 4번이다 — 부호를 뒤집는다.
            events.push({
              kind: 'wheel',
              vertical: true,
              delta: notches.vertical > 0 ? -1 : 1,
              x: point.x,
              y: point.y,
            });
          }
          for (let step = 0; step < Math.abs(notches.horizontal); step += 1) {
            events.push({
              kind: 'wheel',
              vertical: false,
              delta: notches.horizontal > 0 ? 1 : -1,
              x: point.x,
              y: point.y,
            });
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
          // 스캔코드를 함께 싣는다. 쓸지 말지는 코어가 협상 결과로 판단한다 — 서버가 QEMU 확장
          // 키를 쓰지 않으면 keysym 만 나간다. RDP 와 같은 표라 여기서 그대로 가져다 쓴다.
          send([
            { kind: 'key', keysym, pressed: true, keycode: scancodeFor(event.code) ?? 0 },
          ]);
        }}
        onKeyUp={(event) => {
          const keysym = keysymFromEvent(event);
          if (keysym === null) {
            return;
          }
          event.preventDefault();
          send([
            { kind: 'key', keysym, pressed: false, keycode: scancodeFor(event.code) ?? 0 },
          ]);
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
