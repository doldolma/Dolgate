import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { State } from 'react-native-gesture-handler';
import {
  fireGestureHandler,
  getByGestureTestId,
} from 'react-native-gesture-handler/jest-utils';
import { RemoteDesktopSurface } from '../src/components/RemoteDesktopSurface';
import {
  nativePointerButton,
  nativeScroll,
} from '@dolssh/react-native-remote-desktop';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));

// 제스처 **중재**(무엇이 스크롤이고 무엇이 클릭인가)는 라이브러리가 한다 — 손가락 수를
// 선언해 두면 둘째 손가락이 닿는 순간 한 손가락 제스처가 취소된다. 그래서 여기서는 그것을
// 다시 시험하지 않고, **우리 손에 있는 부분**만 본다: 각 제스처가 원격에 무엇을 보내는가.

async function renderSurface(options?: {
  protocol?: 'rdp' | 'vnc';
  inputMode?: 'touch' | 'trackpad';
}) {
  let tree: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <RemoteDesktopSurface
        sessionId="rd-1"
        protocol={options?.protocol ?? 'rdp'}
        status="connected"
        testPattern={false}
        isActiveTab
        inputMode={options?.inputMode ?? 'touch'}
        scaleMode="fit"
        viewOnly={false}
        desktopWidth={1920}
        desktopHeight={1080}
      />,
    );
  });
  return tree!;
}

/** 두 손가락으로 위로 미는 손짓. */
function fireTwoFingerScroll() {
  fireGestureHandler(getByGestureTestId('rd-two-finger-scroll'), [
    { state: State.BEGAN, numberOfPointers: 2 },
    { state: State.ACTIVE, numberOfPointers: 2, translationY: -20 },
    { state: State.ACTIVE, numberOfPointers: 2, translationY: -45 },
    { state: State.ACTIVE, numberOfPointers: 2, translationY: -70 },
    { state: State.END, numberOfPointers: 2, translationY: -70 },
  ]);
}

describe('원격 데스크톱 입력', () => {
  beforeEach(() => {
    (nativeScroll as jest.Mock).mockClear();
    (nativePointerButton as jest.Mock).mockClear();
  });

  it('두 손가락 끌기는 원격 스크롤이 된다', async () => {
    const tree = await renderSurface();
    await act(async () => {
      fireTwoFingerScroll();
    });

    const vertical = (nativeScroll as jest.Mock).mock.calls.filter(
      call => call[1] === true,
    );
    expect(vertical.length).toBeGreaterThan(0);

    await act(async () => {
      tree.unmount();
    });
  });

  it('스크롤하는 동안 버튼을 누르지 않는다', async () => {
    // 예전에는 둘째 손가락이 오기 전에 한 손가락이 좌버튼을 눌러 버려서, 스크롤이 원격에서
    // 클릭·선택이 됐다. 이제 두 제스처가 애초에 갈린다.
    const tree = await renderSurface();
    await act(async () => {
      fireTwoFingerScroll();
    });

    expect(nativePointerButton).not.toHaveBeenCalled();

    await act(async () => {
      tree.unmount();
    });
  });

  it('RDP 는 휠 한 칸을 120 단위로 보낸다', async () => {
    // 두 코어의 단위가 다르다 — vnc-core 는 칸 수, rdp-core 는 회전 단위(120/칸).
    // 칸 수를 그대로 보내면 한 칸의 1/120 만 굴러 아무 일도 일어나지 않는다.
    const tree = await renderSurface({ protocol: 'rdp' });
    await act(async () => {
      fireTwoFingerScroll();
    });

    const vertical = (nativeScroll as jest.Mock).mock.calls.filter(
      call => call[1] === true,
    );
    expect(vertical.length).toBeGreaterThan(0);
    for (const call of vertical) {
      expect(Math.abs(call[2] as number) % 120).toBe(0);
      expect(Math.abs(call[2] as number)).toBeGreaterThanOrEqual(120);
    }

    await act(async () => {
      tree.unmount();
    });
  });

  it('VNC 는 칸 수를 그대로 보낸다', async () => {
    const tree = await renderSurface({ protocol: 'vnc' });
    await act(async () => {
      fireTwoFingerScroll();
    });

    const vertical = (nativeScroll as jest.Mock).mock.calls.filter(
      call => call[1] === true,
    );
    expect(vertical.length).toBeGreaterThan(0);
    for (const call of vertical) {
      expect(Math.abs(call[2] as number)).toBeLessThan(120);
    }

    await act(async () => {
      tree.unmount();
    });
  });

  it('한 손가락 탭은 좌클릭이 된다', async () => {
    const tree = await renderSurface();
    await act(async () => {
      fireGestureHandler(getByGestureTestId('rd-tap'), [
        { state: State.BEGAN, x: 100, y: 200 },
        { state: State.ACTIVE, x: 100, y: 200 },
        { state: State.END, x: 100, y: 200 },
      ]);
    });

    const presses = (nativePointerButton as jest.Mock).mock.calls;
    expect(presses.some(call => call[1] === 0 && call[2] === true)).toBe(true);
    expect(presses.some(call => call[1] === 0 && call[2] === false)).toBe(true);

    await act(async () => {
      tree.unmount();
    });
  });

  it('길게 누르면 우클릭이 된다', async () => {
    const tree = await renderSurface();
    await act(async () => {
      fireGestureHandler(getByGestureTestId('rd-long-press'), [
        { state: State.BEGAN, x: 100, y: 200 },
        { state: State.ACTIVE, x: 100, y: 200 },
        { state: State.END, x: 100, y: 200 },
      ]);
    });

    expect(
      (nativePointerButton as jest.Mock).mock.calls.some(
        call => call[1] === 2 && call[2] === true,
      ),
    ).toBe(true);

    await act(async () => {
      tree.unmount();
    });
  });

  it('한 손가락 끌기는 좌버튼을 눌러 끌고 끝나면 뗀다', async () => {
    // 스크롤을 지키려다 정상적인 드래그(선택·창 이동)를 막으면 안 된다.
    const tree = await renderSurface({ inputMode: 'touch' });
    await act(async () => {
      fireGestureHandler(getByGestureTestId('rd-one-finger-drag'), [
        { state: State.BEGAN, x: 100, y: 200, numberOfPointers: 1 },
        { state: State.ACTIVE, x: 140, y: 200, translationX: 40 },
        { state: State.ACTIVE, x: 180, y: 200, translationX: 80 },
        { state: State.END, x: 180, y: 200, translationX: 80 },
      ]);
    });

    const calls = (nativePointerButton as jest.Mock).mock.calls;
    expect(calls.some(call => call[1] === 0 && call[2] === true)).toBe(true);
    expect(calls.some(call => call[1] === 0 && call[2] === false)).toBe(true);

    await act(async () => {
      tree.unmount();
    });
  });
  it('손가락을 위로 밀면 문서 아래쪽으로 간다 (폰 관습)', async () => {
    // 만지는 기기가 폰이므로 폰의 관습을 따른다 — MS·Chrome 원격 데스크톱 모바일도 같다.
    // RDP 는 휠을 뒤로 굴리는 것(음수)이 "아래로 스크롤" 이다.
    const tree = await renderSurface({ protocol: 'rdp' });
    await act(async () => {
      fireTwoFingerScroll();
    });

    const vertical = (nativeScroll as jest.Mock).mock.calls.filter(
      call => call[1] === true,
    );
    expect(vertical.length).toBeGreaterThan(0);
    for (const call of vertical) {
      expect(call[2] as number).toBeLessThan(0);
    }

    await act(async () => {
      tree.unmount();
    });
  });

  it('손가락을 왼쪽으로 밀면 문서 오른쪽으로 간다', async () => {
    // 세로와 같은 규칙. 부호가 세로와 반대인 것은 휠 규약이 축마다 반대이기 때문이다.
    const tree = await renderSurface({ protocol: 'rdp' });
    await act(async () => {
      fireGestureHandler(getByGestureTestId('rd-two-finger-scroll'), [
        { state: State.BEGAN, numberOfPointers: 2 },
        { state: State.ACTIVE, numberOfPointers: 2, translationX: -20 },
        { state: State.ACTIVE, numberOfPointers: 2, translationX: -45 },
        { state: State.ACTIVE, numberOfPointers: 2, translationX: -70 },
        { state: State.END, numberOfPointers: 2, translationX: -70 },
      ]);
    });

    const horizontal = (nativeScroll as jest.Mock).mock.calls.filter(
      call => call[1] === false,
    );
    expect(horizontal.length).toBeGreaterThan(0);
    for (const call of horizontal) {
      expect(call[2] as number).toBeGreaterThan(0);
    }

    await act(async () => {
      tree.unmount();
    });
  });
});
