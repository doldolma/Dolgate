import { Buffer } from 'buffer';

import {
  buildTerminalGestureScript,
  arrowSequence,
  parseTerminalGestureEvent,
  terminalPasteSequence,
} from '../src/lib/terminal-gestures';

const ESC = String.fromCharCode(27);

describe('arrowSequence', () => {
  it('방향마다 올바른 CSI 를 낸다', () => {
    expect(arrowSequence('up', 1)).toBe(`${ESC}[A`);
    expect(arrowSequence('down', 1)).toBe(`${ESC}[B`);
    expect(arrowSequence('right', 1)).toBe(`${ESC}[C`);
    expect(arrowSequence('left', 1)).toBe(`${ESC}[D`);
  });

  it('count 만큼 반복한다', () => {
    expect(arrowSequence('up', 3)).toBe(`${ESC}[A${ESC}[A${ESC}[A`);
  });

  it('0 이하면 빈 문자열', () => {
    expect(arrowSequence('left', 0)).toBe('');
    expect(arrowSequence('left', -2)).toBe('');
  });
});

describe('parseTerminalGestureEvent', () => {
  const wrap = (payload: unknown) =>
    `__dolgate_gesture__ ${JSON.stringify(payload)}`;

  it('방향키 이벤트를 읽는다', () => {
    expect(
      parseTerminalGestureEvent([wrap({ type: 'arrow', direction: 'up', count: 2 })]),
    ).toEqual({ type: 'arrow', direction: 'up', count: 2 });
  });

  it('복사 이벤트를 읽는다', () => {
    expect(
      parseTerminalGestureEvent([wrap({ type: 'copy', text: 'ls -al' })]),
    ).toEqual({ type: 'copy', text: 'ls -al' });
  });

  it('빈 복사는 버린다', () => {
    // 선택이 비었는데 클립보드를 덮어쓰면 사용자가 갖고 있던 것이 사라진다.
    expect(
      parseTerminalGestureEvent([wrap({ type: 'copy', text: '' })]),
    ).toBeNull();
  });

  it('붙여넣기 요청을 읽는다', () => {
    expect(parseTerminalGestureEvent([wrap({ type: 'paste' })])).toEqual({
      type: 'paste',
    });
  });

  it('더블탭 키 이벤트를 읽는다', () => {
    expect(
      parseTerminalGestureEvent([wrap({ type: 'key', key: 'tab' })]),
    ).toEqual({ type: 'key', key: 'tab' });
    expect(
      parseTerminalGestureEvent([wrap({ type: 'key', key: 'enter' })]),
    ).toBeNull();
  });

  it('count 가 0 이거나 숫자가 아니면 버린다', () => {
    // 0 회를 그대로 보내면 빈 시퀀스를 쓰느라 헛일을 한다.
    expect(
      parseTerminalGestureEvent([wrap({ type: 'arrow', direction: 'up', count: 0 })]),
    ).toBeNull();
    expect(
      parseTerminalGestureEvent([
        wrap({ type: 'arrow', direction: 'up', count: 'many' }),
      ]),
    ).toBeNull();
  });

  it('마커가 없는 로그는 흘려보낸다', () => {
    expect(parseTerminalGestureEvent(['xterm ready'])).toBeNull();
    expect(parseTerminalGestureEvent([{ not: 'a string' }])).toBeNull();
    expect(parseTerminalGestureEvent([])).toBeNull();
  });

  it('깨진 JSON 은 null 로 떨어뜨린다', () => {
    expect(parseTerminalGestureEvent(['__dolgate_gesture__ {oops'])).toBeNull();
  });

  // 그리드 보고와 같은 채널을 쓰므로 서로를 삼키면 안 된다.
  it('그리드 보고 마커에는 반응하지 않는다', () => {
    expect(parseTerminalGestureEvent(['__dolgate_grid__ 80x24'])).toBeNull();
  });
});

describe('terminalPasteSequence', () => {
  it('UTF-8 텍스트를 base64 OSC 로 감싼다', () => {
    const seq = terminalPasteSequence('한글 λ\nls -al');
    const match = seq.match(
      new RegExp(`^${ESC}\\]7771;([A-Za-z0-9+/=]+)${String.fromCharCode(7)}$`),
    );
    expect(match).toBeTruthy();
    expect(Buffer.from(match![1], 'base64').toString('utf8')).toBe('한글 λ\nls -al');
  });
});

describe('buildTerminalGestureScript', () => {
  const labels = { copy: 'Copy', paste: 'Paste', selectAll: 'Select All' };

  it('중복 주입을 막는 가드가 있다', () => {
    // WebView 리마운트마다 다시 주입되므로 핸들러가 겹치면 방향키가 여러 번 나간다.
    expect(buildTerminalGestureScript(labels)).toContain('window.__dolgateGestures');
  });

  it('문법이 유효하다', () => {
    // 주입 문자열이라 빌드가 검사해 주지 않는다 — 여기서 한 번 파싱한다.
    expect(() => new Function(buildTerminalGestureScript(labels))).not.toThrow();
  });

  // 하드코딩해 두면 앱 언어와 무관하게 그 언어로 보인다 — 영문 기기에서 액션 바만 한글로 떴다.
  it('액션 바 문구를 호출부에서 받는다', () => {
    const script = buildTerminalGestureScript(labels);
    expect(script).toContain('"copy":"Copy"');
    expect(script).toContain('"selectAll":"Select All"');
    // 버튼에 문구를 박아 두면 앱 언어와 무관하게 그 언어로 보인다(주석의 한글은 무관하다).
    expect(script).not.toContain("makeButton('복사'");
    expect(script).not.toContain("makeButton('붙여넣기'");
    expect(script).not.toContain("makeButton('전체 선택'");
  });

  it('문구에 따옴표가 있어도 스크립트가 깨지지 않는다', () => {
    const script = buildTerminalGestureScript({
      copy: 'Cop"y',
      paste: "Pas'te",
      selectAll: 'Select\\All',
    });
    expect(() => new Function(script)).not.toThrow();
  });
});
