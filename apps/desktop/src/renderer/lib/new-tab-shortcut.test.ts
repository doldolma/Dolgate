import { afterEach, describe, expect, it, vi } from 'vitest';
import { installNewTabShortcut, matchNewTabShortcut } from './new-tab-shortcut';
import { rdpKeyboardCaptureAttributes } from './rdp-keyboard-focus';

const uninstalls: Array<() => void> = [];

afterEach(() => {
  while (uninstalls.length > 0) {
    uninstalls.pop()?.();
  }
  document.body.innerHTML = '';
});

function install(): { trigger: ReturnType<typeof vi.fn> } {
  const trigger = vi.fn();
  uninstalls.push(installNewTabShortcut(trigger));
  return { trigger };
}

function keyDown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
}

describe('matchNewTabShortcut', () => {
  it('맥의 ⌘T 와 윈도우의 Ctrl+T 를 모두 받는다', () => {
    expect(matchNewTabShortcut(keyDown({ key: 't', metaKey: true }))).toBe(true);
    expect(matchNewTabShortcut(keyDown({ key: 't', ctrlKey: true }))).toBe(true);
    // Caps Lock 이 켜져 있으면 key 가 대문자로 온다.
    expect(matchNewTabShortcut(keyDown({ key: 'T', ctrlKey: true }))).toBe(true);
  });

  it('Shift·Alt 가 붙은 것과 맨 T 는 우리 것이 아니다', () => {
    expect(
      matchNewTabShortcut(keyDown({ key: 'T', ctrlKey: true, shiftKey: true })),
    ).toBe(false);
    expect(
      matchNewTabShortcut(keyDown({ key: 't', ctrlKey: true, altKey: true })),
    ).toBe(false);
    expect(matchNewTabShortcut(keyDown({ key: 't' }))).toBe(false);
  });
});

describe('installNewTabShortcut', () => {
  /**
   * 이 테스트가 이번 회귀의 본체다.
   *
   * 버블 단계로 걸었을 때 윈도우에서 Ctrl+T 가 통째로 죽었다 — 터미널에 포커스가 있으면 xterm 이
   * `stopPropagation()` 으로 이벤트를 끝내서 window 까지 오지 않는다. 여기서는 xterm 자리에
   * "받은 keydown 을 삼키는 요소" 를 놓고 같은 상황을 만든다.
   */
  it('이벤트를 삼키는 요소(xterm) 안에서도 발동한다', () => {
    const { trigger } = install();
    const terminal = document.createElement('div');
    terminal.addEventListener('keydown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    document.body.append(terminal);

    terminal.dispatchEvent(keyDown({ key: 't', ctrlKey: true }));

    expect(trigger).toHaveBeenCalledTimes(1);
  });

  /** 잡은 키는 아래로 흘려보내지 않는다 — 셸에 0x14 가 들어가면 입력 줄 글자가 뒤바뀐다. */
  it('잡은 키는 터미널까지 내려가지 않는다', () => {
    install();
    const terminal = document.createElement('div');
    const seen = vi.fn();
    terminal.addEventListener('keydown', seen);
    document.body.append(terminal);

    const event = keyDown({ key: 't', ctrlKey: true });
    terminal.dispatchEvent(event);

    expect(seen).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('우리 조합이 아니면 그대로 흘려보낸다', () => {
    const { trigger } = install();
    const terminal = document.createElement('div');
    const seen = vi.fn();
    terminal.addEventListener('keydown', seen);
    document.body.append(terminal);

    terminal.dispatchEvent(keyDown({ key: 't', ctrlKey: true, shiftKey: true }));

    expect(trigger).not.toHaveBeenCalled();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  /**
   * 원격 화면(RDP)이 키보드를 쥐고 있으면 Ctrl+T 는 원격 것이다. capture 단계라 캔버스가
   * stopPropagation 으로 막을 수 없으니 우리가 비켜 줘야 한다.
   */
  it('원격 화면에 포커스가 있으면 비켜 준다', () => {
    const { trigger } = install();
    const canvas = document.createElement('canvas');
    for (const [name, value] of Object.entries(rdpKeyboardCaptureAttributes)) {
      canvas.setAttribute(name, value);
    }
    canvas.tabIndex = 0;
    document.body.append(canvas);
    canvas.focus();

    const event = keyDown({ key: 't', ctrlKey: true });
    canvas.dispatchEvent(event);

    expect(trigger).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('해제하면 더 이상 발동하지 않는다', () => {
    const trigger = vi.fn();
    installNewTabShortcut(trigger)();

    window.dispatchEvent(keyDown({ key: 't', ctrlKey: true }));

    expect(trigger).not.toHaveBeenCalled();
  });
});
