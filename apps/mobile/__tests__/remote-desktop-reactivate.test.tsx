import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { RemoteDesktopSurface } from '../src/components/RemoteDesktopSurface';
import Clipboard from '@react-native-clipboard/clipboard';
import {
  nativeKeyEvent,
  nativeRefresh,
  nativeSendClipboard,
  nativeSetActive,
} from '@dolssh/react-native-remote-desktop';

// 스토어를 타고 들어오는 persist 미들웨어가 네이티브 저장소를 찾으므로 여기서 막는다.
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));

// 프레임버퍼는 damage rect 로만 갱신된다. 탭을 옮겨 둔 사이 갱신을 놓치면 그 영역이 낡은
// 그림으로 남으므로, 다시 활성화될 때 화면을 통째로 다시 받아야 한다. setActive 만으로는
// 화면이 요청되지 않는다(표시 정책만 되돌린다) — 이 연결이 끊기면 증상은 "일부만 옛 화면".

function renderSurface(isActiveTab: boolean) {
  return renderer.create(
    <RemoteDesktopSurface
      sessionId="rd-1"
      protocol="vnc"
      status="connected"
      testPattern={false}
      isActiveTab={isActiveTab}
      inputMode="trackpad"
      scaleMode="fit"
      viewOnly={false}
    />,
  );
}

/** 커서는 인라인 PNG 를 쓰는 Image 다. source 로 찾는다. */
function cursorNodes(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll(
    node =>
      typeof node.type === 'string' &&
      String((node.props?.source as { uri?: string } | undefined)?.uri ?? '').startsWith(
        'data:image/png;base64,',
      ),
    { deep: true },
  );
}

describe('RemoteDesktopSurface 재활성화', () => {
  beforeEach(() => {
    (nativeRefresh as jest.Mock).mockClear();
    (nativeSetActive as jest.Mock).mockClear();
  });

  // 접속 직후에는 서버가 이미 전체 화면을 보낸다 — 여기서 또 요청하면 매 접속마다
  // 전체 화면 요청이 한 번씩 더 나간다.
  it('첫 활성화에는 화면을 다시 요청하지 않는다', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderSurface(true);
    });

    expect(nativeRefresh as jest.Mock).not.toHaveBeenCalled();

    await act(async () => {
      tree!.unmount();
    });
  });

  it('탭을 떠났다가 돌아오면 화면을 다시 요청한다', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderSurface(true);
    });
    (nativeRefresh as jest.Mock).mockClear();

    await act(async () => {
      tree!.update(
        <RemoteDesktopSurface
          sessionId="rd-1"
          protocol="vnc"
          status="connected"
          testPattern={false}
          isActiveTab={false}
          inputMode="trackpad"
          scaleMode="fit"
          viewOnly={false}
        />,
      );
    });
    expect(nativeRefresh as jest.Mock).not.toHaveBeenCalled();

    await act(async () => {
      tree!.update(
        <RemoteDesktopSurface
          sessionId="rd-1"
          protocol="vnc"
          status="connected"
          testPattern={false}
          isActiveTab
          inputMode="trackpad"
          scaleMode="fit"
          viewOnly={false}
        />,
      );
    });

    expect(nativeRefresh as jest.Mock).toHaveBeenCalledWith('rd-1');

    await act(async () => {
      tree!.unmount();
    });
  });
});

/**
 * 트랙패드 모드는 **상대 좌표**다 — 커서가 안 보이면 조준이 불가능하고, 클릭은 정확히 나가는데
 * 엉뚱한 자리에 떨어진다(RDP 에서 실제로 겪었다). 그래서 커서 표시는 기능의 일부다.
 *
 * 위치는 Animated transform 으로만 움직이므로 좌표 자체는 여기서 못 본다. 그건
 * remoteToViewport 왕복 테스트가 지킨다.
 */
describe('RemoteDesktopSurface 트랙패드 커서', () => {
  function render(props: {
    inputMode: 'trackpad' | 'touch' | 'none';
    viewOnly?: boolean;
    status?: 'connected' | 'connecting';
  }) {
    return renderer.create(
      <RemoteDesktopSurface
        sessionId="rd-1"
        protocol="rdp"
        status={props.status ?? 'connected'}
        testPattern={false}
        isActiveTab
        inputMode={props.inputMode}
        scaleMode="fit"
        viewOnly={props.viewOnly ?? false}
      />,
    );
  }

  it('트랙패드 모드에서 커서를 그린다', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render({ inputMode: 'trackpad' });
    });
    expect(cursorNodes(tree!).length).toBeGreaterThan(0);
    await act(async () => {
      tree!.unmount();
    });
  });

  // Direct 모드는 손가락이 곧 포인터다 — 점을 하나 더 띄우면 방해만 된다.
  it('Direct 모드에서는 그리지 않는다', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render({ inputMode: 'touch' });
    });
    expect(cursorNodes(tree!)).toHaveLength(0);
    await act(async () => {
      tree!.unmount();
    });
  });

  it('view-only 세션에서는 그리지 않는다', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render({ inputMode: 'trackpad', viewOnly: true });
    });
    expect(cursorNodes(tree!)).toHaveLength(0);
    await act(async () => {
      tree!.unmount();
    });
  });

  it('연결되기 전에는 그리지 않는다', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render({ inputMode: 'trackpad', status: 'connecting' });
    });
    expect(cursorNodes(tree!)).toHaveLength(0);
    await act(async () => {
      tree!.unmount();
    });
  });
});

/**
 * 툴바는 원격 창의 제목줄 자리를 덮는다. 접을 수단이 없으면 그 아래를 영원히 못 만진다.
 * 접었을 때 **손잡이는 남아야** 한다 — 아무것도 안 남으면 되돌릴 방법이 없다.
 */
describe('RemoteDesktopSurface 툴바 접기', () => {
  function surface() {
    return (
      <RemoteDesktopSurface
        sessionId="rd-1"
        protocol="rdp"
        status="connected"
        testPattern={false}
        isActiveTab
        inputMode="trackpad"
        scaleMode="fit"
        viewOnly={false}
      />
    );
  }

  // Pressable 은 host View 에 onPress 를 넘기지 않는다 — onPress 를 들고 있는 쪽을 찾는다.
  function byLabel(tree: renderer.ReactTestRenderer, label: string) {
    return tree.root.findAll(
      node =>
        node.props?.accessibilityLabel === label &&
        typeof node.props?.onPress === 'function',
      { deep: true },
    );
  }

  it('접으면 툴바가 사라지고 손잡이가 남는다', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(surface());
    });

    expect(byLabel(tree!, '툴바 접기').length).toBeGreaterThan(0);
    expect(byLabel(tree!, '툴바 펼치기')).toHaveLength(0);

    await act(async () => {
      byLabel(tree!, '툴바 접기')[0].props.onPress();
    });

    expect(byLabel(tree!, '툴바 접기')).toHaveLength(0);
    expect(byLabel(tree!, '툴바 펼치기').length).toBeGreaterThan(0);

    // 되돌릴 수 있어야 한다.
    await act(async () => {
      byLabel(tree!, '툴바 펼치기')[0].props.onPress();
    });
    expect(byLabel(tree!, '툴바 접기').length).toBeGreaterThan(0);

    await act(async () => {
      tree!.unmount();
    });
  });
});

/**
 * **좌표 계산이 좌상단 원점을 가정한다.**
 *
 * RN 의 기본 transform 원점은 뷰의 중심이라, 이 스타일이 빠지면 확대한 순간
 * `center*(1-scale)` 만큼 전부 어긋난다 — 클릭이 밀리고, 커서가 안 따라오고, 화면 이동이
 * 이상해진다. 배율 1 에서는 두 기준이 일치해서 **테스트 없이는 되돌아가도 아무도 모른다.**
 */
describe('RemoteDesktopSurface 확대 원점', () => {
  it('원격 화면을 좌상단 기준으로 확대한다', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <RemoteDesktopSurface
          sessionId="rd-1"
          protocol="rdp"
          status="connected"
          testPattern={false}
          isActiveTab
          inputMode="trackpad"
          scaleMode="fit"
          viewOnly={false}
        />,
      );
    });

    const flatten = (style: unknown): Array<Record<string, unknown>> =>
      Array.isArray(style)
        ? style.flatMap(flatten)
        : style && typeof style === 'object'
          ? [style as Record<string, unknown>]
          : [];
    const scaled = tree!.root.findAll(
      node =>
        typeof node.type === 'string' &&
        flatten(node.props?.style).some(entry => 'transform' in entry),
      { deep: true },
    );
    const withOrigin = scaled.filter(node =>
      flatten(node.props?.style).some(
        entry => entry.transformOrigin === 'top left',
      ),
    );
    expect(withOrigin.length).toBeGreaterThan(0);

    await act(async () => {
      tree!.unmount();
    });
  });
});

/**
 * 클립보드 버튼은 두 단계를 다 해야 한다.
 *
 * 원격 클립보드에 넣는 것만으로는 화면에 아무것도 나타나지 않는다 — 붙여넣기는 원격에서 키를
 * 눌러야 하고, 모바일 사용자에게는 그 방법이 없다(바에 글자 키가 없다). 여기가 끊기면 증상은
 * "버튼을 눌러도 아무 일도 없다" 다.
 */
describe('RemoteDesktopSurface 클립보드', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (nativeSendClipboard as jest.Mock).mockClear();
    (nativeKeyEvent as jest.Mock).mockClear();
    (Clipboard.getString as jest.Mock).mockResolvedValue('붙여넣을 텍스트');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function byLabel(tree: renderer.ReactTestRenderer, label: string) {
    return tree.root.findAll(
      node =>
        node.props?.accessibilityLabel === label &&
        typeof node.props?.onPress === 'function',
      { deep: true },
    );
  }

  it('기기 클립보드를 보내고 원격에서 Ctrl+V 를 누른다', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <RemoteDesktopSurface
          sessionId="rd-1"
          protocol="rdp"
          status="connected"
          testPattern={false}
          isActiveTab
          inputMode="trackpad"
          scaleMode="fit"
          viewOnly={false}
        />,
      );
    });

    await act(async () => {
      byLabel(tree!, '원격에 클립보드 붙여넣기')[0].props.onPress();
    });

    expect(nativeSendClipboard as jest.Mock).toHaveBeenCalledWith(
      'rd-1',
      '붙여넣을 텍스트',
    );
    // 알림이 그대로 화면에 남는다 — 조용히 실패하면 사용자는 눌린 줄도 모른다.
    // 문구는 결과만 말한다. Ctrl+V 는 우리가 하는 일이라 사용자가 읽을 것이 아니다.
    expect(JSON.stringify(tree!.toJSON())).toContain('원격에 붙여넣었습니다');

    // 보내자마자 누르면 원격이 예전 클립보드를 붙여넣는다. 알림이 갈 시간을 준 뒤에 눌린다.
    expect(nativeKeyEvent as jest.Mock).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    // Ctrl(0x1d) 로 감싼 v(0x2f). RDP 는 스캔코드를 네 번째 인자로 받는다.
    expect((nativeKeyEvent as jest.Mock).mock.calls).toEqual([
      ['rd-1', 0, true, 0x1d],
      ['rd-1', 0, true, 0x2f],
      ['rd-1', 0, false, 0x2f],
      ['rd-1', 0, false, 0x1d],
    ]);

    await act(async () => {
      tree!.unmount();
    });
  });
});

/**
 * 연결 중 패널은 가로에서 잘리면 안 된다.
 *
 * 그 패널이 실패 이유(호스트키 불일치·자격증명 오류)를 보여주는 자리다. 가로에서 재연결하면
 * 세로 공간이 모자라 아래가 잘리는데, 오버레이가 `pointerEvents="none"` 이면 스크롤 뷰로
 * 만들어도 손가락이 통과해 움직이지 않는다.
 */
describe('RemoteDesktopSurface 연결 중 패널', () => {
  it('스크롤 가능하고 손가락을 받는다', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <RemoteDesktopSurface
          sessionId="rd-1"
          protocol="rdp"
          status="connecting"
          testPattern={false}
          isActiveTab
          inputMode="trackpad"
          scaleMode="fit"
          viewOnly={false}
        />,
      );
    });

    const scrollViews = tree!.root.findAll(
      node =>
        typeof node.type === 'string' && node.type.includes('ScrollView'),
      { deep: true },
    );
    expect(scrollViews.length).toBeGreaterThan(0);

    // 오버레이가 none 이면 그 안의 스크롤이 죽는다 — 스크롤을 감싼 쪽을 직접 본다.
    const overlay = tree!.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props?.pointerEvents === 'box-none' &&
        node.findAll(
          child =>
            typeof child.type === 'string' && child.type.includes('ScrollView'),
          { deep: true },
        ).length > 0,
      { deep: true },
    );
    expect(overlay.length).toBeGreaterThan(0);

    await act(async () => {
      tree!.unmount();
    });
  });
});
