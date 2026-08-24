import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { RemoteDesktopSurface } from '../src/components/RemoteDesktopSurface';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));

// SSH 는 오류 배너에 재연결이 있는데 원격 데스크톱에는 없어서, 실패한 탭에서는 다시 붙을
// 길이 없었다(탭을 닫고 홈에서 들어와야 했다). error 상태는 탭이 유지되므로 — 탭 목록은
// status !== 'closed' 를 살아 있는 것으로 본다 — 그 자리에 버튼이 있어야 한다.

async function renderSurface(options: {
  status: 'connecting' | 'connected' | 'error' | 'closed';
  onReconnect?: () => void;
}) {
  let tree: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <RemoteDesktopSurface
        sessionId="rd-1"
        protocol="vnc"
        status={options.status}
        testPattern={false}
        isActiveTab
        title="Lab console"
        errorMessage="연결이 거부되었습니다."
        inputMode="touch"
        scaleMode="fit"
        viewOnly={false}
        onReconnect={options.onReconnect}
      />,
    );
  });
  return tree!;
}

function findReconnect(
  root: renderer.ReactTestInstance,
): renderer.ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.props?.onPress === 'function' &&
      node.props?.accessibilityLabel === 'Lab console 세션 재연결',
  );
}

describe('원격 데스크톱 재연결', () => {
  it('실패한 세션에서 재연결을 누르면 다시 붙인다', async () => {
    const onReconnect = jest.fn();
    const tree = await renderSurface({ status: 'error', onReconnect });

    const buttons = findReconnect(tree.root);
    expect(buttons).toHaveLength(1);

    await act(async () => {
      buttons[0].props.onPress();
    });
    expect(onReconnect).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.unmount();
    });
  });

  it('붙는 중이거나 붙은 뒤에는 재연결을 내지 않는다', async () => {
    for (const status of ['connecting', 'connected'] as const) {
      const tree = await renderSurface({ status, onReconnect: jest.fn() });
      expect(findReconnect(tree.root)).toHaveLength(0);
      await act(async () => {
        tree.unmount();
      });
    }
  });

  // 테스트 패턴처럼 붙을 곳이 없는 화면도 이 컴포넌트를 쓴다 — 핸들러가 없으면 버튼도 없다.
  it('재연결 핸들러가 없으면 버튼을 내지 않는다', async () => {
    const tree = await renderSurface({ status: 'error' });
    expect(findReconnect(tree.root)).toHaveLength(0);
    await act(async () => {
      tree.unmount();
    });
  });
});
