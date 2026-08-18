// 터미널 WebView 안에서 터치 제스처를 판정하고 선택 UI 를 그린다.
//
// **소유권 모델 — 이 파일에서 가장 중요한 사실**: 이 벤더 xterm 번들은 터치 스크롤을
// 네이티브가 아니라 **자기 JS 리스너**로 굴린다(element 의 touchstart/touchmove →
// `viewport.scrollTop += (lastY - pageY)`, slop 없이 첫 픽셀부터). 그래서
// preventDefault·touch-action·overflow 는 전부 무력하다 — 그것들은 네이티브 스크롤만
// 막는 수단이고, JS 리스너는 **이벤트가 닿지 않게(stopPropagation) 해야만** 멈춘다.
// 방향키와 스크롤이 겹치던 원인이 이것이었다.
//
// 그래서 document 의 **capture 단계**에서 xterm 보다 먼저 터치를 받는다:
//   - 스크롤로 확정     → 그 제스처의 나머지를 끊고 우리가 viewport.scrollTop 을 민다.
//   - 홀드가 완성된 뒤 → 그 제스처의 나머지 이벤트를 끊는다. xterm 은 아무것도 못 보므로
//                        방향키 도중 스크롤이 **구조적으로** 불가능하다.
// 한 제스처의 주인은 항상 하나다. 판정 파라미터로 섞임을 줄이는 게 아니라, 전달 자체로
// 소유권을 가른다.
//
// **스크롤까지 우리가 굴리는 이유**: xterm 에 흘려보내면 빠른 플릭이 죽는다 — 1~2px 움찔하고
// 그 제스처가 끝까지 아무 반응이 없다(앱을 켠 직후에 잘 나고, 한동안 쓰다 안정화되면 사라진다).
// xterm 은 touchmove 마다 scrollTop 을 바꾸고 그때마다 DOM 렌더러가 행을 다시 그리는데,
// 그 지연으로 응답이 늦으면 WebView 가 제스처를 회수한다. 그런데 스크롤러(.xterm-viewport)는
// 터치가 닿는 .xterm-screen 의 **형제**라, 회수된 제스처는 굴릴 스크롤러를 못 찾아 아무것도
// 하지 않는다(그래서 "사망"). 우리가 매 이벤트를 claim 하면 회수될 근거가 없고, scrollTop 반영은
// rAF 로 프레임당 1회만 해서 리렌더가 이벤트 응답을 막지 못한다.
// 같은 이유로 스크롤 주체가 하나로 줄어, 방향키와 스크롤이 겹칠 여지도 함께 사라진다.
//
// **RN 제스처를 쓰지 않는 이유**: WebView 가 터치를 먼저 가져가서 래퍼 View 의 onTouch* 까지
// 오지 않는다. 웹 쪽 한 곳에서 판정하면 제스처가 서로 경쟁하지 않는다.
//
// **네이티브 선택을 쓰지 않는 이유**: iOS 에서 길게 누르기가 곧 네이티브 선택 시작이라, 같은
// 제스처를 방향키로 쓰는 이 설계와 정면으로 충돌한다. Termius 도 자체 핸들을 그린다.
//
// **onMessage 대신 debug 채널을 쓰는 이유**: webViewOptions 는 WebView 에 마지막으로
// 스프레드되므로 onMessage 를 넘기면 패키지 자체 핸들러(initialized/input)를 덮어써 터미널
// 입출력이 끊긴다. debug 메시지는 패키지가 logger 로 그대로 흘려준다(그리드 보고와 같은 경로).
//
// **RN→웹 방향 채널이 없다**: 패키지 핸들은 write/clear/focus/blur/resize/fit 뿐이라 RN 이
// 웹에 명령을 내릴 수 없다. 그래서 선택 액션 바(복사·전체 선택)를 웹 안에 그리고, 복사만
// 네이티브 클립보드를 쓰려고 텍스트를 RN 으로 올린다.
//
// **window.terminal 의존**: 벤더 번들이 전역에 올려 두는 xterm 인스턴스다. 공식 계약이 아니라
// 접합면이므로 패키지 업데이트로 이 전역이 사라지면 함께 죽는다. 그리드 보고도 같은 가정이다.

import { Buffer } from 'buffer';

const GESTURE_MARKER = '__dolgate_gesture__';

/**
 * "맨 아래로 스크롤" 신호로 쓰는 OSC 번호.
 *
 * RN→웹 방향 채널이 없어서(패키지 핸들은 write/clear/focus/blur/resize/fit 뿐) 터미널 데이터
 * 흐름에 얹는다. `handle.write()` 로 이 OSC 를 흘려보내면 xterm 파서가 잡아 처리하고 화면에는
 * 아무것도 그리지 않는다 — registerOscHandler 는 공식 API 라 꼼수가 아니다.
 *
 * 번호는 사설 대역에서 골랐다(0~9 는 창 제목 등 표준, 52 는 클립보드처럼 널리 쓰인다).
 */
const OSC_SCROLL_TO_BOTTOM = 7770;

/**
 * "클립보드 텍스트 붙여넣기" 신호로 쓰는 OSC 번호. 같은 사설 대역.
 *
 * 텍스트를 세션에 직접 쓰지 않고 xterm 의 `paste()` 로 우회하는 이유: 원격 앱이 켠
 * bracketed paste 모드(CSI ?2004h)는 xterm 만 알고 있어서, 직접 쓰면 여러 줄 붙여넣기가
 * 줄마다 즉시 실행된다. 페이로드는 base64 — OSC 종결자(BEL/ST)와 충돌할 수 없다.
 */
const OSC_PASTE = 7771;

/**
 * 입력할 때 맨 아래로 되돌리는 신호.
 *
 * 스크롤백을 올려다본 뒤 뭔가 입력하면 커서 위치로 돌아오는 것이 터미널의 기본 동작이다.
 * xterm 에는 `scrollOnUserInput`(기본 true)이 있지만 이 앱은 네이티브 입력 오버레이를 써서
 * xterm 이 키 입력을 직접 받지 않으므로 그 옵션이 발동하지 않는다.
 */
export const TERMINAL_SCROLL_TO_BOTTOM_SEQUENCE = `${String.fromCharCode(27)}]${OSC_SCROLL_TO_BOTTOM};1${String.fromCharCode(7)}`;

export type TerminalGestureEvent =
  /** 커서·히스토리 방향키. count 만큼 반복해서 보낸다. */
  | { type: 'arrow'; direction: 'up' | 'down' | 'right' | 'left'; count: number }
  /** 더블탭. 지금은 Tab 만 쓴다. */
  | { type: 'key'; key: 'tab' }
  /** 사용자가 복사를 눌렀다. 네이티브 클립보드는 RN 쪽에 있다. */
  | { type: 'copy'; text: string }
  /** 사용자가 붙여넣기를 눌렀다. RN 이 클립보드를 읽어 OSC 로 되돌려준다. */
  | { type: 'paste' }
  /** 제스처 판정 추적. 원인을 잡는 동안만 쓴다. */
  | { type: 'trace'; text: string };

/** 판정 파라미터. 웹으로 주입되므로 값만 갖는다. */
export const TERMINAL_GESTURE_TUNING = {
  /**
   * 이 시간을 넘겨 누르고 있으면 롱프레스로 본다(떼면 단어 선택, 움직이면 방향키).
   *
   * 200 으로 뒀다가 올렸다 — 스크롤하려다 방향키 모드로 빠졌다. "스크롤 의도는 ~150ms 안에
   * 움직인다"는 건 빠른 플릭에만 맞고, 천천히 끌기 시작하면 그 안에 holdCancelPx 를 넘지
   * 못해 롱프레스로 확정된다. 플랫폼 기본은 이보다 훨씬 길다(iOS·Android·RN 모두 500ms).
   *
   * 올린 대가는 판정이 끝날 때까지 움직임을 삼키는 구간이 그만큼 길어지는 것뿐이다.
   * holdCancelPx 를 넘기면 즉시 스크롤로 넘겨주므로 아주 느리게 끄는 경우에만 손에 걸린다.
   */
  longPressMs: 300,
  /**
   * 홀드를 취소하고 스크롤로 넘길 이동 거리(px).
   *
   * 손가락을 대면 자리 잡느라 10px 남짓은 그냥 밀린다 — 빡빡하면 오래 눌러도 스크롤로
   * 확정돼 버린다. 한 줄 높이(~25px)보다는 작게 둬서, 삼켰다 넘겨주는 점프가 눈에 안 띄게.
   *
   * 이 안쪽의 미세 이동은 우리가 삼킨다 — xterm 자체 스크롤은 slop 없이 첫 픽셀부터
   * 화면을 움직이므로, 흘려보내면 홀드하는 동안 화면이 떨린다.
   */
  holdCancelPx: 16,
  /**
   * 홀드가 끝난 지점부터, 방향키 축을 정하기까지 필요한 최소 이동(px).
   *
   * 홀드 완성 시점의 자리를 기준으로 재므로 자리 잡는 동안의 흔들림은 이미 빠져 있다.
   * 손떨림(±3px 남짓)만 거르면 되니 작게 둔다 — 크면 "움직였는데 방향키가 안 나간다"가 된다.
   */
  axisLockPx: 6,
  /**
   * 방향키 한 칸에 필요한 이동 거리를 **셀 크기의 배수**로 정한다.
   *
   * 고정 픽셀로 두면 기기마다 어긋난다 — 터미널 한 칸은 가로 5px 남짓, 세로 25px 남짓이라
   * 같은 14px 이 좌우로는 세 글자, 상하로는 반 줄이 된다. 가로는 한 글자에 한 칸,
   * 세로는 한 줄의 8할쯤이 손에 맞았다(꽉 채우면 길고, 절반이면 너무 예민하다).
   *
   * 시간 기준(밀어 둔 채 두면 계속 반복)으로 만들었다가 되돌렸다 — 멈춰도 계속 눌려서
   * 원하는 줄에 설 수가 없었다.
   */
  arrowStepCellsX: 1,
  arrowStepCellsY: 0.8,
  /** 셀 계산이 실패했을 때만 쓰는 하한(px). */
  arrowStepMinPx: 5,
  /** 더블탭으로 인정하는 간격(ms)과 허용 이동(px). */
  doubleTapMs: 300,
  doubleTapSlopPx: 16,
  /**
   * 선택 핸들을 "잡은 것"으로 인정하는 반경(px). 핸들 점은 22px 지만 손가락은 그보다
   * 크다 — 히트 판정을 DOM 노드에 맡기면 몇 px 빗나간 터치가 스크롤로 빠져 핸들을
   * 움직일 수 없다. 거리로 판정한다.
   */
  handleGrabPx: 28,
} as const;

/**
 * 주입 스크립트. `window.terminal` 이 올라올 때까지 기다렸다가 document capture 단계에
 * 터치 핸들러를 건다(파일 상단의 소유권 모델 참고).
 *
 * - 그냥 드래그            → xterm 자체 스크롤 (우리는 손대지 않는다)
 * - 길게 누르고 **떼면**    → 그 자리 단어 선택
 * - 길게 누르고 **움직이면** → 우세한 축으로 잠그고 방향키 (xterm 에는 이벤트가 닿지 않는다)
 * - 짧게 두 번 탭          → Tab
 * - 짧게 한 번 탭          → 손대지 않는다 (원래 동작: 포커스 → 키보드)
 *
 * 선택이 생기면 양 끝에 핸들과 액션 바(복사·전체 선택)를 그린다. 범위는 드래그가 아니라
 * 핸들을 끌어서 넓힌다 — iOS 텍스트 선택과 같은 방식이다. 핸들·바는 자기 리스너에서
 * stopPropagation 하므로 xterm 에도, 이 판정기에도 닿지 않는다.
 */
/**
 * 액션 바에 쓸 문구. 주입 스크립트는 WebView 안에서 도는 순수 JS 라 i18n 을 쓸 수 없으므로
 * 호출부가 넘긴다 — 하드코딩해 두면 앱 언어와 무관하게 그 언어로 보인다(실제로 한글로 보였다).
 *
 * 스크립트는 WebView 가 마운트될 때 한 번 주입되므로, 세션이 떠 있는 동안 언어를 바꾸면 그 세션의
 * 바에는 이전 문구가 남는다. 다음에 그 판을 열면 새 문구로 주입된다.
 */
export interface TerminalGestureLabels {
  copy: string;
  paste: string;
  selectAll: string;
}

export function buildTerminalGestureScript(
  labels: TerminalGestureLabels,
): string {
  return `(function () {
  if (window.__dolgateGestures) { return; }
  window.__dolgateGestures = true;

  var TUNING = ${JSON.stringify(TERMINAL_GESTURE_TUNING)};
  var MARKER = '${GESTURE_MARKER}';
  var OSC_SCROLL = ${OSC_SCROLL_TO_BOTTOM};
  var OSC_PASTE = ${OSC_PASTE};
  var LABELS = ${JSON.stringify(labels)};

  function post(payload) {
    try {
      if (!window.ReactNativeWebView) { return; }
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'debug',
        message: MARKER + ' ' + JSON.stringify(payload)
      }));
    } catch (error) {}
  }

  function attach(term) {
    var element = term.element;
    if (!element) { return false; }

    // RN 이 입력을 보낼 때 함께 흘려보내는 신호. 스크롤백을 올려다본 상태였다면 맨 아래로
    // 되돌린다. true 를 돌려줘야 xterm 이 "처리됨"으로 보고 화면에 아무것도 그리지 않는다.
    try {
      term.parser.registerOscHandler(OSC_SCROLL, function () {
        try { term.scrollToBottom(); } catch (error) {}
        return true;
      });
    } catch (error) {}
    // RN 이 클립보드 내용을 base64 로 실어 보낸다. term.paste 가 bracketed paste 를
    // 알아서 처리하고, 입력이니 맨 아래로 되돌린다.
    try {
      term.parser.registerOscHandler(OSC_PASTE, function (data) {
        try {
          var raw = atob(data);
          var text;
          if (typeof TextDecoder === 'function') {
            var bytes = new Uint8Array(raw.length);
            for (var i = 0; i < raw.length; i += 1) { bytes[i] = raw.charCodeAt(i); }
            text = new TextDecoder('utf-8').decode(bytes);
          } else {
            text = decodeURIComponent(escape(raw));
          }
          if (text) {
            term.paste(text);
            term.scrollToBottom();
          }
        } catch (error) {}
        return true;
      });
    } catch (error) {}
    if (getComputedStyle(element).position === 'static') {
      element.style.position = 'relative';
    }

    // 커서를 보이게 하려면 xterm 이 포커스를 갖고 있어야 한다(렌더러가 내부 포커스 상태를
    // 보고 커서를 그린다). 붙을 때 한 번만 — preventScroll 은 포커스가 화면을 끌어당기는
    // 부수효과를 막는다.
    try {
      var helper = element.querySelector('.xterm-helper-textarea');
      if (helper && helper.focus) {
        helper.focus({ preventScroll: true });
      } else {
        term.focus();
      }
    } catch (error) {}

    // 선택 범위(버퍼 절대 좌표). null 이면 선택 없음.
    var sel = null;
    var state = null;
    var lastTapAt = 0, lastTapX = 0, lastTapY = 0;

    // ---- 선택 UI (핸들 2개 + 액션 바) ----
    var layer = document.createElement('div');
    layer.style.cssText =
      'position:absolute;inset:0;pointer-events:none;z-index:20;display:none;' +
      'overflow:hidden';
    element.appendChild(layer);

    // 하이라이트는 우리가 직접 그린다 — xterm 의 선택 상태(term.select)에 얹으면 iOS 의
    // 합성 클릭 한 방에 지워진다(마우스 전용 기능이라 터치와는 애초에 안 맞는다).
    // 색은 흰/검 배경 모두에서 보이는 반투명 파랑(iOS 텍스트 선택 계열).
    function makeHighlight() {
      var node = document.createElement('div');
      node.style.cssText =
        'position:absolute;background:rgba(0,122,255,0.28);border-radius:2px;' +
        'pointer-events:none;display:none';
      layer.appendChild(node);
      return node;
    }
    var hlFirst = makeHighlight();
    var hlMid = makeHighlight();
    var hlLast = makeHighlight();

    function placeRect(node, col, visRow, colSpan, rowSpan, m) {
      node.style.left = (m.ox + col * m.cw) + 'px';
      node.style.top = (m.oy + visRow * m.ch) + 'px';
      node.style.width = Math.max(2, colSpan * m.cw) + 'px';
      node.style.height = (rowSpan * m.ch) + 'px';
      node.style.display = 'block';
    }

    function makeHandle() {
      var node = document.createElement('div');
      // pointer-events:none — 히트 판정은 아래 grabHandle 이 거리로 한다. 22px 점의
      // DOM 히트에 맡기면 몇 px 빗나간 터치가 전부 스크롤로 빠진다.
      node.style.cssText =
        'position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;' +
        'border-radius:50%;background:rgba(120,120,128,0.85);pointer-events:none';
      layer.appendChild(node);
      return node;
    }
    var startHandle = makeHandle();
    var endHandle = makeHandle();

    var bar = document.createElement('div');
    bar.style.cssText =
      'position:absolute;transform:translate(-50%,-100%);display:flex;gap:2px;' +
      'background:#2b2b30;border-radius:8px;overflow:hidden;pointer-events:auto;' +
      'font:600 13px -apple-system,system-ui,sans-serif;white-space:nowrap';
    layer.appendChild(bar);

    function makeButton(label, onTap) {
      var node = document.createElement('div');
      node.textContent = label;
      node.style.cssText = 'padding:9px 16px;color:#fff';
      node.addEventListener('touchend', function (event) {
        event.preventDefault();
        event.stopPropagation();
        // preventDefault 로도 iOS 는 ~300ms 뒤 합성 클릭을 쏜다. 그게 xterm 에 닿으면
        // 포커스 이동 등 엉뚱한 일이 생기므로 잠깐 차단한다(suppressMouseUntil 은 아래
        // 제스처 판정부에서 선언 — var 라 실행 시점엔 살아 있다).
        suppressMouseUntil = Date.now() + 700;
        onTap();
      });
      bar.appendChild(node);
      return node;
    }

    function metrics() {
      // 루트(.xterm)가 아니라 **글자 격자 그 자체**(.xterm-screen)를 잰다. fit 은
      // rows=floor(높이/셀높이)로 잡으므로 루트에는 한 셀 미만의 자투리가 남고, 루트
      // 높이로 나누면 셀이 부풀어 아래로 갈수록 행 계산이 어긋난다 — 맨 아래 프롬프트
      // 줄에서 오차가 최대라 "프롬프트 꾹 누르면 항상 빈 줄을 짚는" 꼴이 된다.
      var screen = element.querySelector('.xterm-screen');
      var target = screen || element;
      var rect = target.getBoundingClientRect();
      var elemRect = element.getBoundingClientRect();
      return {
        rect: rect,
        // 오버레이(핸들·바)는 element 기준 absolute 라 격자의 오프셋을 더해 준다.
        ox: rect.left - elemRect.left,
        oy: rect.top - elemRect.top,
        cw: rect.width / term.cols,
        ch: rect.height / term.rows
      };
    }

    function cellFromTouch(touch) {
      var m = metrics();
      var col = Math.floor((touch.clientX - m.rect.left) / m.cw);
      var row = Math.floor((touch.clientY - m.rect.top) / m.ch);
      return {
        col: Math.max(0, Math.min(term.cols - 1, col)),
        row: term.buffer.active.viewportY +
             Math.max(0, Math.min(term.rows - 1, row))
      };
    }

    function applySelection() {
      if (!sel) { layer.style.display = 'none'; return; }
      var a = sel.from, b = sel.to;
      var forward = b.row > a.row || (b.row === a.row && b.col >= a.col);
      var from = forward ? a : b;
      var to = forward ? b : a;
      layout(from, to);
    }

    function layout(from, to) {
      var m = metrics();
      var base = term.buffer.active.viewportY;
      var rows = to.row - from.row;

      // 첫 줄 부분 / 중간 통줄 / 끝 줄 부분 — 최대 3개 사각형. 뷰포트 밖은 layer 의
      // overflow:hidden 이 잘라 준다.
      placeRect(hlFirst, from.col, from.row - base,
        rows === 0 ? to.col - from.col + 1 : term.cols - from.col, 1, m);
      if (rows >= 2) {
        placeRect(hlMid, 0, from.row - base + 1, term.cols, rows - 1, m);
      } else { hlMid.style.display = 'none'; }
      if (rows >= 1) {
        placeRect(hlLast, 0, to.row - base, to.col + 1, 1, m);
      } else { hlLast.style.display = 'none'; }

      var sx = m.ox + from.col * m.cw, sy = m.oy + (from.row - base) * m.ch + m.ch;
      var ex = m.ox + (to.col + 1) * m.cw, ey = m.oy + (to.row - base) * m.ch + m.ch;
      // 빈 곳 붙여넣기 바가 숨겼을 수 있는 것들을 선택 모드로 복원한다.
      // 붙여넣기는 선택과 무관하다(터미널의 붙여넣기는 선택을 대체하지 않는다) —
      // 선택 바에서는 숨기고, 빈 곳 꾹 바에서만 보인다.
      copyButton.style.display = '';
      pasteButton.style.display = 'none';
      startHandle.style.display = 'block';
      endHandle.style.display = 'block';
      startHandle.style.left = sx + 'px';
      startHandle.style.top = sy + 'px';
      endHandle.style.left = ex + 'px';
      endHandle.style.top = ey + 'px';
      // 바는 선택을 가리지 않는 곳에 — 기본은 선택 위, 맨 윗줄처럼 위에 자리가
      // 없으면 선택 아래로 뒤집는다(iOS 콜아웃 규칙). 핸들 위에 얹히면 바가 터치를
      // 먹어 핸들을 잡을 수 없다. 위아래 다 없으면(전체 선택) 화면 중앙.
      var aboveBottom = sy - m.ch - 8;
      if (aboveBottom >= 44) {
        bar.style.transform = 'translate(-50%,-100%)';
        bar.style.top = aboveBottom + 'px';
      } else if (ey + 14 + 44 <= m.rect.height) {
        bar.style.transform = 'translate(-50%,0)';
        bar.style.top = (ey + 14) + 'px';
      } else {
        bar.style.transform = 'translate(-50%,-100%)';
        bar.style.top = (m.rect.height / 2) + 'px';
      }
      bar.style.left =
        Math.max(70, Math.min(m.rect.width - 70, (sx + ex) / 2)) + 'px';
      layer.style.display = 'block';
    }

    function selectionText() {
      // 선택의 원본은 우리 sel 이고, 텍스트는 버퍼에서 직접 뽑는다 — xterm 의 선택
      // 상태(getSelection)에 기대면 합성 클릭으로 지워진 순간 복사가 빈손이 된다.
      if (!sel) { return ''; }
      try {
        var a = sel.from, b = sel.to;
        var forward = b.row > a.row || (b.row === a.row && b.col >= a.col);
        var from = forward ? a : b;
        var to = forward ? b : a;
        var out = '';
        for (var row = from.row; row <= to.row; row += 1) {
          var line = term.buffer.active.getLine(row);
          var text = line ? line.translateToString(true) : '';
          if (row === from.row && row === to.row) {
            text = text.slice(from.col, to.col + 1);
          } else if (row === from.row) {
            text = text.slice(from.col);
          } else if (row === to.row) {
            text = text.slice(0, to.col + 1);
          }
          if (row > from.row) {
            // 화면 폭에 감겨 여러 행이 된 줄(isWrapped)은 원래 한 줄이다 — 개행을
            // 넣으면 복사한 명령이 쪼개진다.
            out += (line && line.isWrapped) ? '' : '\\n';
          }
          out += text;
        }
        return out;
      } catch (error) { return ''; }
    }

    function clearSelection() {
      sel = null;
      applySelection();
    }

    var copyButton = makeButton(LABELS.copy, function () {
      var text = selectionText();
      if (text) { post({ type: 'copy', text: text }); }
      clearSelection();
    });
    var pasteButton = makeButton(LABELS.paste, function () {
      post({ type: 'paste' });
      clearSelection();
    });
    makeButton(LABELS.selectAll, function () {
      try {
        var last = term.buffer.active.length - 1;
        sel = { from: { col: 0, row: 0 }, to: { col: term.cols - 1, row: last } };
        applySelection();
      } catch (error) {}
    });

    // 핸들 근처에서 시작한 터치인지 — 잡았다면 어느 쪽인지. 판정 전에 sel 방향을
    // 정규화해 start=from, end=to 를 보장한다(거꾸로 끌어 만든 선택 대비).
    function grabHandle(touch) {
      if (!sel || layer.style.display !== 'block') { return null; }
      var a = sel.from, b = sel.to;
      var forward = b.row > a.row || (b.row === a.row && b.col >= a.col);
      sel = forward ? { from: a, to: b } : { from: b, to: a };
      var m = metrics();
      var base = term.buffer.active.viewportY;
      var sx = m.rect.left + sel.from.col * m.cw;
      var sy = m.rect.top + (sel.from.row - base) * m.ch + m.ch;
      var ex = m.rect.left + (sel.to.col + 1) * m.cw;
      var ey = m.rect.top + (sel.to.row - base) * m.ch + m.ch;
      var ds = Math.hypot(touch.clientX - sx, touch.clientY - sy);
      var de = Math.hypot(touch.clientX - ex, touch.clientY - ey);
      if (Math.min(ds, de) > TUNING.handleGrabPx) { return null; }
      return ds <= de ? 'start' : 'end';
    }

    // ---- 제스처 판정 (document capture — xterm 리스너보다 항상 먼저) ----

    function endGesture() {
      // 스크롤 중이었다면 마지막 프레임을 반영하고 끝낸다 — 버리면 뗄 때 몇 px 이 남는다.
      if (state && state.mode === 'scroll') { applyScroll(); }
      cancelScroll();
      if (state) {
        if (state.timer) { clearTimeout(state.timer); }
        if (state.node && state.node.removeEventListener) {
          state.node.removeEventListener('touchmove', onTouchMove);
          state.node.removeEventListener('touchend', onTouchEnd);
          state.node.removeEventListener('touchcancel', onTouchCancel);
        }
      }
      state = null;
    }

    // 같은 이벤트가 document(capture)와 타깃 노드 양쪽 리스너로 두 번 들어올 수 있다.
    // 먼저 받은 쪽이 마크를 찍고, 뒤에 받은 쪽은 물러난다.
    function alreadyHandled(event) {
      if (event.__dolgateSeen) { return true; }
      try { event.__dolgateSeen = true; } catch (error) {}
      return false;
    }

    // 이 이벤트를 이 제스처의 주인으로서 가져간다: xterm(버블 리스너)에게 전달을 끊고,
    // 네이티브 기본 동작(합성 클릭 등)도 막는다.
    function claim(event) {
      event.stopPropagation();
      if (event.cancelable) { event.preventDefault(); }
    }

    // 우리가 소비한 제스처의 끝. touchend 의 preventDefault 만으로는 부족하다 —
    // iOS WebView 는 그래도 ~300ms 뒤 합성 클릭(mousedown)을 쏘고, xterm 의 mousedown
    // 핸들러가 그걸 받아 **방금 만든 선택을 지운다**. 잠깐 마우스 이벤트를 차단한다.
    var suppressMouseUntil = 0;
    function claimEnd(event) {
      claim(event);
      suppressMouseUntil = Date.now() + 700;
    }
    ['mousedown', 'mouseup', 'click'].forEach(function (type) {
      document.addEventListener(type, function (event) {
        if (Date.now() < suppressMouseUntil) {
          event.stopPropagation();
          if (event.cancelable) { event.preventDefault(); }
        }
      }, { capture: true, passive: false });
    });

    // 스크롤러는 .xterm-viewport 하나다. xterm 이 행을 다시 그려도 이 요소는 유지되지만,
    // 터미널이 재생성되는 경우까지 감안해 끊기면 다시 찾는다.
    var viewportEl = null;
    function scrollViewport() {
      if (!viewportEl || !viewportEl.isConnected) {
        viewportEl = document.querySelector('.xterm-viewport');
      }
      return viewportEl;
    }

    // 이벤트마다 scrollTop 을 만지면 그때마다 리렌더가 붙어 이벤트 처리가 밀린다(그 지연이
    // 곧 제스처 회수다). 좌표만 받아 두고 반영은 프레임당 한 번만 한다.
    var scrollFrame = 0;
    function scheduleScroll() {
      if (scrollFrame) { return; }
      scrollFrame = requestAnimationFrame(function () {
        scrollFrame = 0;
        applyScroll();
      });
    }
    function cancelScroll() {
      if (scrollFrame) { cancelAnimationFrame(scrollFrame); scrollFrame = 0; }
    }
    function applyScroll() {
      if (!state || state.mode !== 'scroll') { return; }
      var el = scrollViewport();
      if (!el) { return; }
      // 손가락이 올라가면 내용은 내려간다 — xterm 이 하던 것과 같은 부호.
      var delta = state.scrollFromY - state.curY;
      if (!delta) { return; }
      var max = el.scrollHeight - el.clientHeight;
      var next = el.scrollTop + delta;
      if (next < 0) { next = 0; } else if (next > max) { next = max; }
      el.scrollTop = next;
      // 이번 프레임의 이동은 소비했다. 경계에서 남은 양은 버린다 — 들고 있으면 되돌릴 때
      // 그만큼 밀어야 움직여서 끝에서 손이 붙잡히는 느낌이 난다.
      state.scrollFromY = state.curY;
    }

    function insideOverlay(event) {
      try { return layer.contains(event.target); } catch (error) { return false; }
    }

    // 글자 없는 곳을 꾹 눌렀다 뗐을 때 — 선택할 것은 없지만 붙여넣기는 여기서 한다
    // (iOS 텍스트 필드의 빈 곳 롱프레스와 같은 관례).
    function showPasteBar(px, py) {
      var rect = element.getBoundingClientRect();
      sel = null;
      hlFirst.style.display = 'none';
      hlMid.style.display = 'none';
      hlLast.style.display = 'none';
      startHandle.style.display = 'none';
      endHandle.style.display = 'none';
      copyButton.style.display = 'none';
      pasteButton.style.display = '';
      bar.style.transform = 'translate(-50%,-100%)';
      bar.style.left = Math.max(70, Math.min(rect.width - 70, px - rect.left)) + 'px';
      bar.style.top = Math.max(44, py - rect.top - 10) + 'px';
      layer.style.display = 'block';
    }

    function selectWordAt(cell, px, py) {
      try {
        var line = term.buffer.active.getLine(cell.row);
        var text = line ? line.translateToString(false) : '';
        var isWord = function (ch) { return ch && /[^\\s]/.test(ch); };
        if (!isWord(text[cell.col])) {
          post({ type: 'trace', text:
            'select miss r' + cell.row + ' c' + cell.col +
            ' ch=' + JSON.stringify(text[cell.col] || '') });
          showPasteBar(px, py);
          return;
        }
        var start = cell.col, end = cell.col;
        while (start > 0 && isWord(text[start - 1])) { start -= 1; }
        while (end < text.length - 1 && isWord(text[end + 1])) { end += 1; }
        sel = { from: { col: start, row: cell.row }, to: { col: end, row: cell.row } };
        applySelection();
        post({ type: 'trace', text:
          'select ' + JSON.stringify(text.slice(start, end + 1)) });
      } catch (error) {}
    }

    document.addEventListener('touchstart', function (event) {
      if (insideOverlay(event)) { return; }
      if (event.touches.length !== 1) { endGesture(); return; }
      var touch = event.touches[0];
      var now = Date.now();

      // 선택 핸들 근처의 터치는 무조건 핸들 드래그다 — 다른 판정(더블탭·홀드·스크롤)보다
      // 먼저. 시작부터 우리가 가지므로 xterm 은 이 제스처를 아예 모른다.
      var grabbed = grabHandle(touch);
      if (grabbed) {
        state = { mode: 'handle', which: grabbed, node: event.target, timer: null };
        if (state.node && state.node.addEventListener) {
          state.node.addEventListener('touchmove', onTouchMove, { passive: false });
          state.node.addEventListener('touchend', onTouchEnd, { passive: false });
          state.node.addEventListener('touchcancel', onTouchCancel, { passive: false });
        }
        claim(event);
        return;
      }

      // 더블탭 "후보"만 표시하고 판정은 touchend 로 미룬다. 여기서 바로 소비하면
      // 탭 직후의 꾹(홀드)이 Tab 으로 먹혀 버린다 — 두 번째 터치도 홀드로 발전할 수
      // 있고, 그때는 롱프레스가 이겨야 한다. touchstart 를 흘려보내도 잃는 것은 없다.
      var tapCandidate =
        now - lastTapAt < TUNING.doubleTapMs &&
        Math.abs(touch.clientX - lastTapX) < TUNING.doubleTapSlopPx &&
        Math.abs(touch.clientY - lastTapY) < TUNING.doubleTapSlopPx;

      // 선택 없이 떠 있는 붙여넣기 바는 다음 터치에서 닫는다(iOS 와 같은 소멸 규칙).
      // 선택이 있는 바는 스크롤 중에도 유지한다.
      if (!sel && layer.style.display === 'block') {
        layer.style.display = 'none';
      }

      state = {
        mode: 'pending',
        tapCandidate: tapCandidate,
        armed: false,
        startX: touch.clientX,
        startY: touch.clientY,
        curX: touch.clientX,
        curY: touch.clientY,
        // 홀드가 끝난 순간의 자리. 방향키 이동량은 여기서부터 잰다.
        armX: touch.clientX,
        armY: touch.clientY,
        axis: null,
        sent: 0,
        anchor: cellFromTouch(touch),
        timer: null
      };
      state.timer = setTimeout(function () {
        if (!state || state.mode !== 'pending') { return; }
        state.armed = true;
        state.armX = state.curX;
        state.armY = state.curY;
        // 방향키 모드에서 선택이 남아 있으면 혼란스럽다.
        if (sel) { clearSelection(); }
        post({ type: 'trace', text: 'armed' });
      }, TUNING.longPressMs);

      // **타깃 노드에도** 나머지 이벤트를 건다. 터치는 시작 시점의 타깃(글자 span)에
      // 평생 묶이는데, xterm 은 행을 다시 그릴 때마다 span 을 통째로 갈아치운다(커서
      // 깜빡임, 출력 에코 전부). 타깃이 DOM 에서 떨어지면 이벤트가 조상으로 전파되지
      // 않아 document 리스너가 벙어리가 된다 — "armed 까지만 나오고 죽는" 원인.
      // 분리된 노드에도 이벤트 자체는 계속 배달되므로, 노드에 직접 걸면 산다.
      state.node = event.target;
      if (state.node && state.node.addEventListener) {
        state.node.addEventListener('touchmove', onTouchMove, { passive: false });
        state.node.addEventListener('touchend', onTouchEnd, { passive: false });
        state.node.addEventListener('touchcancel', onTouchCancel, { passive: false });
      }
      // touchstart 는 흘려보낸다 — 스크롤로 판정될 수 있으므로 xterm 이 기준 좌표를
      // 잡아 두게 한다. 탭이면 원래 동작(포커스→키보드)도 이 흐름으로 산다.
    }, { capture: true, passive: false });

    function onTouchMove(event) {
      if (alreadyHandled(event)) { return; }
      if (insideOverlay(event)) { return; }
      if (!state) { return; }

      if (state.mode === 'handle') {
        claim(event);
        if (sel && event.touches.length) {
          var grabCell = cellFromTouch(event.touches[0]);
          if (state.which === 'start') { sel.from = grabCell; } else { sel.to = grabCell; }
          applySelection();
        }
        return;
      }

      var touch = event.touches[0];
      if (!touch) { return; }
      state.curX = touch.clientX;
      state.curY = touch.clientY;

      // 스크롤로 확정된 제스처 — 끝까지 우리 것이다. xterm 은 아무것도 못 본다.
      if (state.mode === 'scroll') {
        claim(event);
        scheduleScroll();
        return;
      }

      if (state.mode === 'pending' && !state.armed) {
        var dx0 = state.curX - state.startX;
        var dy0 = state.curY - state.startY;
        if (Math.abs(dx0) > TUNING.holdCancelPx || Math.abs(dy0) > TUNING.holdCancelPx) {
          // 홀드 전에 이만큼 움직였으면 스크롤이다. 이 이벤트부터 우리가 굴린다.
          // 기준점을 touchstart 지점으로 잡아, 삼켜 뒀던 오프셋을 첫 프레임에 따라잡는다.
          if (state.timer) { clearTimeout(state.timer); state.timer = null; }
          state.mode = 'scroll';
          state.scrollFromY = state.startY;
          claim(event);
          scheduleScroll();
          post({ type: 'trace', text: 'scroll' });
          return;
        }
        // 판정 전의 미세 이동은 삼킨다 — xterm 스크롤은 slop 없이 첫 픽셀부터 움직여서,
        // 흘리면 홀드하는 동안 화면이 떨린다.
        claim(event);
        return;
      }

      // armed(축 미정) 또는 arrow — 이 제스처는 우리 것: xterm 이 보지 못하게 한다.
      claim(event);
      var dx = state.curX - state.armX;
      var dy = state.curY - state.armY;
      if (state.mode === 'pending') {
        if (Math.abs(dx) <= TUNING.axisLockPx && Math.abs(dy) <= TUNING.axisLockPx) {
          return;
        }
        state.mode = 'arrow';
        state.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
        // 스텝 기산점은 홀드 지점이 아니라 **잠금 임계선**(홀드 지점 + axisLockPx)이다.
        //
        // 홀드 지점부터 재면, 뗄 때 손가락이 구르는 8px 남짓이 가로 한 스텝(셀 폭 ~5px)을
        // 바로 채워 스트레이 화살표가 나가고 단어 선택도 죽는다. 임계선부터면 굴림은
        // 잠금을 넘고도 한 스텝을 더 채워야 하므로 대부분 걸러진다.
        //
        // "잠금을 넘긴 이벤트의 위치"가 아니라 임계선을 쓰는 이유: 빠른 플릭은 한 이벤트에
        // 수십 px 을 건너뛰므로, 이벤트 위치 기준이면 그만큼이 기산점에 흡수돼 화살표를
        // 잃는다. 임계선은 이벤트 굵기와 무관하다.
        var travel0 = state.axis === 'x' ? dx : dy;
        state.base = (state.axis === 'x' ? state.armX : state.armY) +
          (travel0 > 0 ? TUNING.axisLockPx : -TUNING.axisLockPx);
        post({ type: 'trace', text: 'arrow axis=' + state.axis });
      }

      // 임계선부터 잰다. 움직인 만큼만 눌리고, 되돌리면 반대 방향으로 눌린다.
      var travelled = (state.axis === 'x' ? state.curX : state.curY) - state.base;
      var m = metrics();
      var stepPx = state.axis === 'x'
        ? m.cw * TUNING.arrowStepCellsX
        : m.ch * TUNING.arrowStepCellsY;
      if (!(stepPx > TUNING.arrowStepMinPx)) { stepPx = TUNING.arrowStepMinPx; }
      var steps = Math.trunc(travelled / stepPx);
      var delta = steps - state.sent;
      if (delta === 0) { return; }
      state.sent = steps;
      var direction = state.axis === 'x'
        ? (delta > 0 ? 'right' : 'left')
        : (delta > 0 ? 'down' : 'up');
      post({ type: 'arrow', direction: direction, count: Math.abs(delta) });
    }
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });

    function onTouchEnd(event) {
      if (alreadyHandled(event)) { return; }
      if (insideOverlay(event)) { return; }
      if (!state) { return; }
      var mode = state.mode;
      var armed = state.armed;
      var anchor = state.anchor;
      var sent = state.sent;
      var endX = state.curX;
      var endY = state.curY;
      var tapCandidate = state.tapCandidate;
      var touch = event.changedTouches && event.changedTouches[0];
      endGesture();

      if (mode === 'handle') {
        // 드래그 끝 — 합성 클릭이 선택 위에 떨어지지 않게 막는다.
        claimEnd(event);
        return;
      }

      if (mode === 'arrow') {
        // 합성 클릭(포커스 이동)까지 막아 제스처를 여기서 닫는다.
        claimEnd(event);
        // 축은 잠겼지만 방향키가 한 번도 안 나갔다 = 뗄 때 손가락이 구른 것이다.
        // 이걸 방향키 취급하면 단어 선택이 "아예 안 되는" 기능이 된다 — 릴리즈 때
        // 6px 남짓은 거의 항상 밀리기 때문이다. 홀드-릴리즈로 인정한다.
        if (sent === 0) { selectWordAt(anchor, endX, endY); }
        return;
      }

      if (mode === 'pending' && armed) {
        // 길게 누르고 움직이지 않은 채 뗐다 — 그 자리 단어 선택.
        claimEnd(event);
        selectWordAt(anchor, endX, endY);
        return;
      }

      if (mode === 'pending' && touch) {
        // 홀드도 이동도 아니었다 = 깨끗한 탭.
        if (tapCandidate) {
          // 직전 탭에 바로 이어진 두 번째 탭 — 더블탭 확정. 합성 클릭은 막는다.
          claimEnd(event);
          lastTapAt = 0;
          post({ type: 'key', key: 'tab' });
          return;
        }
        // 손대지 않고 흘린다(원래 동작: 포커스 → 키보드). 더블탭 판정 기준은
        // **탭의 끝**에만 남긴다 — 스크롤·홀드 뒤의 탭이 더블탭으로 오인되지 않게.
        lastTapAt = Date.now();
        lastTapX = touch.clientX;
        lastTapY = touch.clientY;
        if (sel) { clearSelection(); }
      }
      // scroll: 이동은 endGesture 가 마지막 프레임까지 반영했다. 여기서 할 일은 없다 —
      // touchmove 를 계속 막았으므로 합성 클릭도 오지 않는다.
    }
    document.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });

    function onTouchCancel() { endGesture(); }
    document.addEventListener('touchcancel', onTouchCancel, { capture: true });

    // 화면이 스크롤되면 핸들 위치가 어긋난다. 선택은 유지하되 다시 그린다.
    try {
      term.onScroll(function () {
        if (sel) { applySelection(); }
      });
    } catch (error) {}

    // 붙을 때 실측값을 한 번 보고한다 — 스텝이 셀 크기 기준이라 기기별 확인용.
    // 원인을 잡으면 지운다.
    try {
      var m0 = metrics();
      post({ type: 'trace', text:
        'attached cell=' + m0.cw.toFixed(1) + 'x' + m0.ch.toFixed(1) +
        ' grid=' + term.cols + 'x' + term.rows });
    } catch (error) {}

    return true;
  }

  var attempts = 0;
  var timer = setInterval(function () {
    attempts += 1;
    if (window.terminal && attach(window.terminal)) {
      clearInterval(timer);
      return;
    }
    if (attempts > 200) { clearInterval(timer); }
  }, 50);
})();
true;`;
}

/** 패키지 logger 인자에서 제스처 이벤트를 골라낸다(그 외 로그는 그대로 흘린다). */
export function parseTerminalGestureEvent(
  args: readonly unknown[],
): TerminalGestureEvent | null {
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg.startsWith(GESTURE_MARKER)) {
      continue;
    }
    const payload = arg.slice(GESTURE_MARKER.length).trim();
    try {
      const parsed = JSON.parse(payload) as TerminalGestureEvent;
      if (parsed.type === 'arrow') {
        return Number.isFinite(parsed.count) && parsed.count > 0 ? parsed : null;
      }
      if (parsed.type === 'key') {
        return parsed.key === 'tab' ? parsed : null;
      }
      if (parsed.type === 'copy') {
        return typeof parsed.text === 'string' && parsed.text ? parsed : null;
      }
      if (parsed.type === 'paste') {
        return { type: 'paste' };
      }
      if (parsed.type === 'trace') {
        return typeof parsed.text === 'string' ? parsed : null;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 클립보드 텍스트를 웹으로 실어 보내는 OSC 시퀀스. 웹 쪽 핸들러가 base64 를 풀어
 * `term.paste()` 로 넣는다(bracketed paste 존중). RN 전용 — 웹에는 Buffer 가 없다.
 */
export function terminalPasteSequence(text: string): string {
  const esc = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  return `${esc}]${OSC_PASTE};${encoded}${bel}`;
}

/**
 * 방향키로 보낼 문자열. CSI(ESC [) 시퀀스를 count 만큼 반복한다.
 *
 * 커서키 모드(DECCKM)를 켠 전체화면 앱은 ESC O A 를 기대하지만, 이 제스처의 목적은
 * 셸(readline)에서의 커서 이동과 히스토리라 일반 모드만 보낸다.
 */
export function arrowSequence(
  direction: 'up' | 'down' | 'left' | 'right',
  count: number,
): string {
  const code =
    direction === 'up'
      ? 'A'
      : direction === 'down'
        ? 'B'
        : direction === 'right'
          ? 'C'
          : 'D';
  // ESC 를 소스에 제어문자로 박지 않고 코드포인트로 만든다 — 눈에 안 보이는
  // 문자는 편집 중 조용히 유실되기 쉽다.
  const esc = String.fromCharCode(27);
  return `${esc}[${code}`.repeat(Math.max(0, count));
}
