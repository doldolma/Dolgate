import { useEffect } from 'react';
import type { VncCursorPayload } from '@shared';

import { subscribeVncCursor } from '../../services/desktop/vnc';

/**
 * 브라우저가 받아들이는 커서 한 변의 상한.
 *
 * Chromium 은 이보다 큰 이미지를 **조용히 무시한다** — `url(...)` 전체가 버려지고 뒤에 적은 대체
 * 커서가 쓰인다. 그래서 여기서 걸러 대체 커서를 명시적으로 고른다(무시된 것과 결과는 같지만,
 * 왜 그런지가 코드에 남는다).
 */
const MAX_SIDE = 128;

/**
 * 커서 모양을 CSS `cursor` 값으로 만든다.
 *
 * 세 갈래다:
 *
 * - 크기가 0 이면 `none` — 서버가 커서를 감춘 것이다. 로컬 포인터까지 감춰야 원격과 같아 보인다.
 * - 그릴 수 없으면 `default` — 브라우저 한도를 넘거나 픽셀 수가 안 맞거나 2D 컨텍스트가 없다.
 *   **커서가 사라지게 두지 않는다**: 서버는 커서를 화면에 그려 주지 않으므로, 여기서 아무 값도
 *   주지 않으면 포인터가 아예 보이지 않는다.
 * - 그릴 수 있으면 PNG data URL + 핫스팟.
 */
export function toCursorStyle(cursor: VncCursorPayload): string {
  if (cursor.width === 0 || cursor.height === 0) {
    return 'none';
  }
  if (cursor.width > MAX_SIDE || cursor.height > MAX_SIDE) {
    return 'default';
  }
  if (cursor.pixels.length !== cursor.width * cursor.height * 4) {
    return 'default';
  }

  const canvas = document.createElement('canvas');
  canvas.width = cursor.width;
  canvas.height = cursor.height;
  const context = canvas.getContext('2d');
  if (!context) {
    return 'default';
  }
  // putImageData 는 곱해지지 않은(non-premultiplied) RGBA 를 기대한다 — 코어가 보내는 것이 그것이다.
  context.putImageData(
    new ImageData(
      new Uint8ClampedArray(cursor.pixels),
      cursor.width,
      cursor.height,
    ),
    0,
    0,
  );

  // 핫스팟이 이미지 밖이면 브라우저가 값 전체를 버린다. 안쪽으로 물린다.
  const hotspotX = Math.max(0, Math.min(cursor.width - 1, cursor.hotspotX));
  const hotspotY = Math.max(0, Math.min(cursor.height - 1, cursor.hotspotY));
  return `url(${canvas.toDataURL('image/png')}) ${hotspotX} ${hotspotY}, default`;
}

/**
 * 원격 커서 모양을 이 요소의 CSS 커서로 붙인다.
 *
 * **이 훅이 없으면 커서가 보이지 않는다.** 코어가 Cursor 의사 인코딩을 선언한 순간부터 서버는
 * 커서를 화면 픽셀에 그려 넣지 않는다. 그 대가로 커서가 네트워크 왕복 없이 움직이고, 모양도 원격이
 * 정한 것(I-빔·크기 조절 화살표)으로 바뀐다.
 */
export function useVncCursor(
  sessionId: string,
  surfaceRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    // 요소를 지금 붙잡아 둔다. 정리할 때 ref 를 다시 읽으면 이미 비어 있어서(React 가 정리보다
    // 먼저 ref 를 떼어낸다) 커서를 되돌리지 못한다 — useVncAutoResize 와 같은 이유·같은 모양이다.
    const surface = surfaceRef.current;
    if (!enabled || !surface) {
      return;
    }
    const unsubscribe = subscribeVncCursor(sessionId, (cursor) => {
      surface.style.cursor = toCursorStyle(cursor);
    });

    return () => {
      unsubscribe();
      // 세션이 끝난 뒤에 원격 모양이 남아 있으면, 그 화면이 사라진 자리에서도 그 커서가 보인다.
      surface.style.cursor = '';
    };
  }, [sessionId, surfaceRef, enabled]);
}
