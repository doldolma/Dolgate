// 화면 배율(Cmd +/-).
//
// Electron 의 페이지 줌은 렌더러 전체를 키운다. 그런데 macOS 신호등은 OS 가 물리 좌표로
// 그리므로(main.ts 의 trafficLightPosition) 상단바만 같이 커지면 둘이 어긋난다. 그래서
// 상단바는 렌더러에서 이 배율의 역수로 되돌려 물리 크기를 고정한다 — 그러려면 지금 배율이
// 얼마인지 렌더러가 알아야 하고, 그 통로가 window:zoom-changed 다.
//
// 배율을 OS 기본 롤(viewMenu)에 맡기지 않고 여기서 쥐는 이유가 그것이다. 롤은 배율이 바뀌어도
// 알려 주지 않고, 단계도 무한히 늘어난다.

import { BrowserWindow, type WebContents } from 'electron';
import { ipcChannels } from '../common/ipc-channels';

/**
 * 고를 수 있는 배율.
 *
 * 무한히 키우고 줄이는 대신 단계를 못 박는다. 아래로 더 내려가면 터미널 글자가 읽히지 않고,
 * 위로 더 가면 상단바 대비 창이 우스워진다.
 *
 * 값이 소수라 상단바를 되돌릴 때(1/배율) 나누어떨어지지 않으면 1px 이음새가 생길 수 있다.
 * 그래서 이 목록은 "쓸 만해 보이는 숫자" 가 아니라 **실제로 재 보고 남긴 것** 이다. 1.15 는
 * 상단바와 스페이서가 어긋나서(1/128px) 뺐다.
 *
 * 많이 키우면 사이드바·우측 패널이 접힌다. 창 폭은 그대로인데 CSS 뷰포트가 배율만큼 줄어
 * `max-[1040px]:hidden` 같은 규칙에 걸리기 때문이다. 이것은 고치지 않기로 한 것이다 — 확대하면
 * 덜 들어가는 게 자연스럽고, 브라우저도 그렇게 동작한다.
 *
 * 단계를 바꿀 때는 앱을 띄워 각 배율에서 상단바 경계·신호등 정렬·탭 줄을 눈으로 확인할 것.
 */
export const APP_ZOOM_STEPS = [0.75, 0.9, 1, 1.1, 1.25, 1.5] as const;

const DEFAULT_ZOOM = 1;

/**
 * 창이 지금 쓰기로 한 배율. **창이 사는 동안만 산다** — 여기 없으면 100% 다.
 *
 * 이 표가 필요한 이유는 Chromium 이 배율을 우리 대신 기억하기 때문이다(아래 참고). 우리가 쥔
 * 값을 로드가 끝날 때마다 다시 걸어야 "기억하지 않는다" 가 실제로 지켜진다.
 */
const desiredZoomByWindowId = new Map<number, number>();

/** 목록 밖 값(옛 빌드에서 올라온 상태 파일 등)은 가장 가까운 단계로 끌어당긴다. */
export function nearestZoomStepIndex(factor: number): number {
  let best = 0;
  for (let index = 1; index < APP_ZOOM_STEPS.length; index += 1) {
    const closer =
      Math.abs(APP_ZOOM_STEPS[index] - factor) < Math.abs(APP_ZOOM_STEPS[best] - factor);
    if (closer) {
      best = index;
    }
  }
  return best;
}

function notify(contents: WebContents, factor: number): void {
  if (contents.isDestroyed()) {
    return;
  }
  contents.send(ipcChannels.window.zoomChanged, factor);
}

/**
 * 창을 배율 100% 로 시작시킨다.
 *
 * 배율은 **기억하지 않는다.** 네이티브 앱이 확대·축소될 거라고 기대하는 사람은 많지 않아서,
 * Cmd +/- 는 실수로 눌리는 쪽이 흔하다. 그 상태가 재시작 후에도 남아 있으면 사용자는 앱이 왜
 * 이상한지 모른 채 그대로 지내게 된다 — 껐다 켜면 제자리로 돌아오는 편이 낫다.
 *
 * 로드가 끝난 뒤 한 번 알리는 것은 빼놓을 수 없다 — 창을 만드는 시점의 알림은 아직 아무도
 * 듣지 않아서, 상단바가 역보정을 걸 수 있는 건 이때부터다.
 *
 * 핀치 줌도 여기서 막는다. 트랙패드로 배율이 단계 밖으로 새면 상단바 역보정이 검증한 적 없는
 * 값 위에서 돌게 된다.
 */
export function prepareWindowZoom(window: BrowserWindow): void {
  const contents = window.webContents;
  contents.setVisualZoomLevelLimits(1, 1).catch(() => {
    // 플랫폼에 따라 거절될 수 있다. 키보드 배율은 그대로 동작한다.
  });
  desiredZoomByWindowId.set(window.id, DEFAULT_ZOOM);
  window.on('closed', () => {
    desiredZoomByWindowId.delete(window.id);
  });
  contents.setZoomFactor(DEFAULT_ZOOM);
  notify(contents, DEFAULT_ZOOM);

  contents.on('did-finish-load', () => {
    // **여기서 다시 거는 것이 핵심이다.**
    //
    // Chromium 은 배율을 호스트마다 **디스크에** 기억한다(userData 의 Preferences 안
    // `partition.per_host_zoom_levels`). 창을 만들 때 건 100% 는 페이지 로드가 끝나는 순간
    // 그 기억으로 덮어써진다 — 예전에는 여기서 getZoomFactor() 를 *읽어* 렌더러에 알리기만
    // 해서, 되살아난 배율을 그대로 받아들이고 상단바까지 거기 맞춰 보정했다. 그래서 "배율은
    // 기억하지 않는다" 고 적어 두고도 실수로 누른 확대가 재시작 뒤까지 남았다.
    //
    // 리로드하면 렌더러가 --app-zoom 을 잃으므로 알려 주는 것도 그대로 필요하다. 이 창이 쓰기로
    // 한 값을 걸고 알리면 둘 다 된다 — 첫 로드는 100%, 리로드는 사용자가 고른 그 배율.
    const factor = desiredZoomByWindowId.get(window.id) ?? DEFAULT_ZOOM;
    contents.setZoomFactor(factor);
    notify(contents, factor);
  });

  // 윈도우·리눅스에서는 감춘 메뉴 항목의 단축키가 살아나지 않는다(acceleratorWorksWhenHidden 은
  // macOS 전용). 시프트 없이 누르는 `Ctrl+=` 확대는 여기서 받는다.
  if (process.platform !== 'darwin') {
    contents.on('before-input-event', (event, input) => {
      // `=` 는 시프트 없이 누르는 확대, `+` 는 숫자패드다. 메뉴 단축키(Ctrl+Shift+=)가 이미
      // 잡는 조합은 여기 오지 않는다.
      const isZoomIn =
        input.type === 'keyDown' &&
        (input.key === '=' || input.key === '+') &&
        input.control &&
        !input.alt &&
        !input.meta;
      if (!isZoomIn) {
        return;
      }
      event.preventDefault();
      stepAppZoom(1);
    });
  }
}

/**
 * 한 단계 키우거나 줄인다. `direction: 0` 은 100% 로 되돌린다.
 *
 * 양끝에서는 아무 일도 일어나지 않는다 — 목록 밖으로 나갈 길을 두지 않는다.
 */
export function stepAppZoom(direction: -1 | 0 | 1): void {
  const window = BrowserWindow.getFocusedWindow();
  if (!window) {
    return;
  }
  const contents = window.webContents;
  const current = nearestZoomStepIndex(contents.getZoomFactor());
  const next =
    direction === 0
      ? APP_ZOOM_STEPS.indexOf(DEFAULT_ZOOM)
      : Math.min(APP_ZOOM_STEPS.length - 1, Math.max(0, current + direction));
  const factor = APP_ZOOM_STEPS[next];
  if (factor === contents.getZoomFactor()) {
    return;
  }
  // 이 창이 쓰기로 한 값이다 — 리로드가 나면 did-finish-load 가 이 값을 다시 건다.
  desiredZoomByWindowId.set(window.id, factor);
  contents.setZoomFactor(factor);
  notify(contents, factor);
}
