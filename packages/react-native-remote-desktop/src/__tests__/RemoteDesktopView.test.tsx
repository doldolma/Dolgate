import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import {
  RemoteDesktopView,
  resolveSurfaceBackgroundColor,
} from '../RemoteDesktopView';

// Mock the native component
jest.mock('../RemoteDesktopSurfaceNativeComponent', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: React.forwardRef((props: any, ref: any) =>
      React.createElement('RemoteDesktopSurface', { ...props, ref }),
    ),
  };
});

describe('RemoteDesktopView', () => {
  it('renders with required props', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <RemoteDesktopView sessionId="test-session" protocol="vnc" />,
      );
    });
    const root = tree!.root;
    expect(root.findByType('RemoteDesktopSurface' as any)).toBeTruthy();
  });

  it('passes all props through to native component', async () => {
    const onReady = jest.fn();
    const onDestroyed = jest.fn();
    const onMetrics = jest.fn();

    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <RemoteDesktopView
          sessionId="sess-123"
          protocol="rdp"
          paused={true}
          testPattern={false}
          backgroundColor="#FF0000"
          onSurfaceReady={onReady}
          onSurfaceDestroyed={onDestroyed}
          onMetrics={onMetrics}
        />,
      );
    });

    const native = tree!.root.findByType('RemoteDesktopSurface' as any);
    expect(native.props.sessionId).toBe('sess-123');
    expect(native.props.protocol).toBe('rdp');
    expect(native.props.paused).toBe(true);
    expect(native.props.testPattern).toBe(false);
    // 색은 **처리된 숫자**로 넘어가야 한다. 값 자체는 플랫폼에 따라 다르다(안드로이드는
    // 부호 있는 32비트, iOS 는 부호 없는 ARGB) — 숫자인지만 본다.
    expect(typeof native.props.backgroundColor).toBe('number');
  });

  it('defaults paused=false and testPattern=true', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <RemoteDesktopView sessionId="s1" protocol="vnc" />,
      );
    });
    const native = tree!.root.findByType('RemoteDesktopSurface' as any);
    expect(native.props.paused).toBe(false);
    expect(native.props.testPattern).toBe(true);
  });

  it('wraps surfaceReady event correctly', async () => {
    const onReady = jest.fn();
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <RemoteDesktopView
          sessionId="s1"
          protocol="vnc"
          onSurfaceReady={onReady}
        />,
      );
    });
    const native = tree!.root.findByType('RemoteDesktopSurface' as any);

    await act(async () => {
      native.props.onSurfaceReady({ nativeEvent: { width: 1920, height: 1080 } });
    });
    expect(onReady).toHaveBeenCalledWith({ width: 1920, height: 1080 });
  });

  it('wraps metrics event correctly', async () => {
    const onMetrics = jest.fn();
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <RemoteDesktopView
          sessionId="s1"
          protocol="vnc"
          onMetrics={onMetrics}
        />,
      );
    });
    const native = tree!.root.findByType('RemoteDesktopSurface' as any);

    await act(async () => {
      native.props.onMetrics({
        nativeEvent: { fps: 30.0, dirtyRects: 1, frameTimeMs: 33.3 },
      });
    });
    expect(onMetrics).toHaveBeenCalledWith({
      fps: 30.0,
      dirtyRects: 1,
      frameTimeMs: 33.3,
    });
  });

  it('wraps surfaceDestroyed event correctly', async () => {
    const onDestroyed = jest.fn();
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <RemoteDesktopView
          sessionId="s1"
          protocol="vnc"
          onSurfaceDestroyed={onDestroyed}
        />,
      );
    });
    const native = tree!.root.findByType('RemoteDesktopSurface' as any);

    await act(async () => {
      native.props.onSurfaceDestroyed({ nativeEvent: {} });
    });
    expect(onDestroyed).toHaveBeenCalled();
  });
});

/**
 * 색 prop 은 문자열로 건너가면 **안드로이드에서 뷰를 만드는 순간 던진다** —
 * "ColorValue: the value must be a number or Object". RDP/VNC 연결 직후 redbox 가 뜨던 원인이다.
 * iOS 의 RCTConvert 는 16진 문자열도 받아 주기 때문에 그쪽만 조용히 동작했다.
 */
describe('resolveSurfaceBackgroundColor', () => {
  it('색 문자열을 숫자로 바꾼다', () => {
    expect(typeof resolveSurfaceBackgroundColor('#000000')).toBe('number');
    expect(typeof resolveSurfaceBackgroundColor('rgba(0, 0, 0, 0.5)')).toBe(
      'number',
    );
    expect(typeof resolveSurfaceBackgroundColor('red')).toBe('number');
  });

  // 해석할 수 없으면 네이티브가 자기 기본값(검정)을 쓰게 둔다 — 잘못된 숫자를 넘기는 것보다 낫다.
  it('해석할 수 없는 값은 넘기지 않는다', () => {
    expect(resolveSurfaceBackgroundColor('not-a-color')).toBeUndefined();
  });
});
