import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { RemoteDesktopKeyboardInput } from '../src/components/RemoteDesktopKeyboardInput';
import type { NativeTerminalInputEvent } from '../src/lib/terminal-input';

// 네이티브 입력 뷰를 대신 세워 두고, 그 뷰가 주는 이벤트가 원격 키 이벤트로 옮겨지는지 본다.
let capturedOnInput:
  | ((event: { nativeEvent: NativeTerminalInputEvent }) => void)
  | null = null;

jest.mock('../src/components/TerminalInputView', () => {
  const mockReact = require('react') as typeof React;
  return {
    TerminalInputView: mockReact.forwardRef((props: any, _ref: unknown) => {
      capturedOnInput = props.onTerminalInput;
      return mockReact.createElement('TerminalInputView', props);
    }),
  };
});

function render(protocol: 'rdp' | 'vnc') {
  const onKeyEvent = jest.fn();
  const onUnicodeEvent = jest.fn();
  const tree = renderer.create(
    <RemoteDesktopKeyboardInput
      protocol={protocol}
      visible
      onDismiss={jest.fn()}
      onKeyEvent={onKeyEvent}
      onUnicodeEvent={onUnicodeEvent}
    />,
  );
  return { tree, onKeyEvent, onUnicodeEvent };
}

function pressBarKey(tree: renderer.ReactTestRenderer, label: string) {
  const button = tree.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
    { deep: true },
  )[0];
  button.props.onPress();
}

describe('RemoteDesktopKeyboardInput', () => {
  beforeEach(() => {
    capturedOnInput = null;
  });

  it('바가 열리면 네이티브 입력 뷰를 붙인다', async () => {
    let ctx: ReturnType<typeof render>;
    await act(async () => {
      ctx = render('rdp');
    });
    expect(capturedOnInput).toBeInstanceOf(Function);
    await act(async () => ctx!.tree.unmount());
  });

  // 바 버튼과 네이티브 special-key 가 같은 경로를 쓴다 — 하나만 고쳐져 어긋나지 않게.
  it('바의 Tab 은 RDP 스캔코드로 나간다', async () => {
    let ctx: ReturnType<typeof render>;
    await act(async () => {
      ctx = render('rdp');
    });
    await act(async () => pressBarKey(ctx!.tree, 'Tab'));
    expect(ctx!.onKeyEvent).toHaveBeenCalledWith(0, true, 0x0f);
    expect(ctx!.onKeyEvent).toHaveBeenCalledWith(0, false, 0x0f);
    await act(async () => ctx!.tree.unmount());
  });

  /**
   * 조합 입력의 결과는 네이티브가 "몇 글자 지우고 무엇을 넣어라" 로 준다. 그걸 그대로 옮기면
   * 원격에는 최종 글자만 남는다 — 예전에는 JS 가 텍스트 상태를 비교하다 `ㄱ가간가나` 를 만들었다.
   */
  it('text-delta 를 백스페이스 + 글자로 옮긴다', async () => {
    let ctx: ReturnType<typeof render>;
    await act(async () => {
      ctx = render('rdp');
    });
    await act(async () =>
      capturedOnInput!({
        nativeEvent: { kind: 'text-delta', deleteCount: 1, insertText: 'a' },
      }),
    );
    // 백스페이스(0x0e) 한 번, 그다음 'a'(0x1e)
    expect(ctx!.onKeyEvent).toHaveBeenCalledWith(0, true, 0x0e);
    expect(ctx!.onKeyEvent).toHaveBeenCalledWith(0, true, 0x1e);
    await act(async () => ctx!.tree.unmount());
  });

  it('매핑 없는 문자는 유니코드로 넘긴다', async () => {
    let ctx: ReturnType<typeof render>;
    await act(async () => {
      ctx = render('rdp');
    });
    await act(async () =>
      capturedOnInput!({
        nativeEvent: { kind: 'text-delta', deleteCount: 0, insertText: '가' },
      }),
    );
    expect(ctx!.onUnicodeEvent).toHaveBeenCalledWith('가'.codePointAt(0), true);
    await act(async () => ctx!.tree.unmount());
  });

  it('special-key 의 ctrl 은 Ctrl 로 감싼다', async () => {
    let ctx: ReturnType<typeof render>;
    await act(async () => {
      ctx = render('rdp');
    });
    await act(async () =>
      capturedOnInput!({
        nativeEvent: { kind: 'special-key', key: 'c', ctrl: true },
      }),
    );
    const calls = ctx!.onKeyEvent.mock.calls;
    expect(calls[0]).toEqual([0, true, 0x1d]); // ctrl down
    expect(calls[1]).toEqual([0, true, 0x2e]); // c down
    expect(calls[3]).toEqual([0, false, 0x1d]); // ctrl up
    await act(async () => ctx!.tree.unmount());
  });

  it('VNC 는 keysym 으로 나간다', async () => {
    let ctx: ReturnType<typeof render>;
    await act(async () => {
      ctx = render('vnc');
    });
    await act(async () =>
      capturedOnInput!({
        nativeEvent: { kind: 'text-delta', deleteCount: 0, insertText: 'a' },
      }),
    );
    expect(ctx!.onKeyEvent).toHaveBeenCalledWith(0x61, true, 0);
    await act(async () => ctx!.tree.unmount());
  });
});

/**
 * 바의 배치.
 *
 * 감싸는 상자에 안전영역 패딩을 주면 상자의 프레임과 그려지는 내용이 어긋나고, iOS 는 부모
 * 프레임 밖의 자식을 보여만 주고 터치는 주지 않는다 — 실제로 둘째 줄과 숨기기 버튼이 눌리지
 * 않았다. 상자를 하나로 두고 인셋을 그 안쪽 패딩으로 넣는 것이 그 어긋남을 없앤다.
 */
describe('RemoteDesktopKeyboardInput 배치', () => {
  function flatten(style: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(style)) return style.flatMap(flatten);
    return style && typeof style === 'object'
      ? [style as Record<string, unknown>]
      : [];
  }

  it('안전영역을 바 자신의 패딩으로 넣고 바닥에 붙는다', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <RemoteDesktopKeyboardInput
          protocol="rdp"
          visible
          insets={{ bottom: 21, left: 44, right: 44 }}
          onDismiss={jest.fn()}
          onKeyEvent={jest.fn()}
          onUnicodeEvent={jest.fn()}
        />,
      );
    });

    // 바깥 상자가 하나뿐이어야 한다 — 그 상자가 위치와 인셋을 모두 들고 있다.
    const root = tree!.root.findAll(node => typeof node.type === 'string', {
      deep: true,
    })[0];
    const style = Object.assign({}, ...flatten(root.props.style));
    expect(style.position).toBe('absolute');
    expect(style.bottom).toBe(0);
    expect(style.paddingBottom).toBe(27);
    expect(style.paddingLeft).toBe(44);
    expect(style.paddingRight).toBe(44);

    await act(async () => tree!.unmount());
  });

  it('숨기기 버튼이 onDismiss 를 부른다', async () => {
    const onDismiss = jest.fn();
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <RemoteDesktopKeyboardInput
          protocol="rdp"
          visible
          onDismiss={onDismiss}
          onKeyEvent={jest.fn()}
          onUnicodeEvent={jest.fn()}
        />,
      );
    });

    await act(async () => pressBarKey(tree!, '키보드 닫기'));
    expect(onDismiss).toHaveBeenCalled();

    await act(async () => tree!.unmount());
  });
});

/**
 * 한 번 눌러 떼는 Win 키.
 *
 * 수정키 줄의 Meta 는 누른 상태를 유지하는 토글이라(Win+R 같은 조합을 위해) 시작 메뉴를 열려면
 * 두 번 눌러야 했다 — 윈도우는 키를 **놓을 때** 시작 메뉴를 연다. 그래서 두 동작을 다른 키로
 * 나눴다.
 */
describe('RemoteDesktopKeyboardInput Win 키', () => {
  it('RDP 는 Win 스캔코드를 눌렀다 뗀다', async () => {
    let ctx: ReturnType<typeof render>;
    await act(async () => {
      ctx = render('rdp');
    });

    await act(async () => pressBarKey(ctx!.tree, 'Win'));

    expect(ctx!.onKeyEvent.mock.calls).toEqual([
      [0, true, 0xe05b],
      [0, false, 0xe05b],
    ]);
    await act(async () => ctx!.tree.unmount());
  });

  // 리눅스 데스크톱의 단축키는 Meta_L(0xffe7) 이 아니라 Super_L(0xffeb) 에 걸려 있다.
  it('VNC 는 Super_L 을 보낸다', async () => {
    let ctx: ReturnType<typeof render>;
    await act(async () => {
      ctx = render('vnc');
    });

    await act(async () => pressBarKey(ctx!.tree, 'Super'));

    expect(ctx!.onKeyEvent.mock.calls).toEqual([
      [0xffeb, true, 0],
      [0xffeb, false, 0],
    ]);
    await act(async () => ctx!.tree.unmount());
  });
});
