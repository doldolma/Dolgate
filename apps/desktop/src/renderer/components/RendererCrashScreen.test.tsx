import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../ui';
import { RendererCrashScreen } from './RendererCrashScreen';

// main.tsx 가 창을 감싸는 방식 그대로 조립해 확인한다. 이 조합이 없으면 렌더 오류가 창을 빈
// 화면으로 남긴다 — 설치된 1.8.10 이 동기화로 받은 RDP 호스트를 그리다 던져 실제로 그랬고,
// 사용자에게는 아무 단서도 남지 않았다.

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function Window({ broken }: { broken: boolean }) {
  if (broken) {
    throw new TypeError("Cannot read properties of undefined (reading 'trim')");
  }
  return <div>워크스페이스</div>;
}

describe('RendererCrashScreen', () => {
  it('창이 죽으면 빈 화면 대신 오류 문구를 보여준다', () => {
    render(
      <ErrorBoundary fallback={(error, reset) => <RendererCrashScreen error={error} onRetry={reset} />}>
        <Window broken />
      </ErrorBoundary>,
    );

    expect(screen.getByText('화면을 그리지 못했습니다')).toBeTruthy();
    // 오류 문구를 그대로 보여줘야 사용자가 전할 것이 있다.
    expect(screen.getByText(/reading 'trim'/)).toBeTruthy();
  });

  it('다시 시도로 복구된다', () => {
    function Harness() {
      const [broken, setBroken] = useState(true);
      return (
        <ErrorBoundary
          fallback={(error, reset) => (
            <RendererCrashScreen
              error={error}
              onRetry={() => {
                setBroken(false);
                reset();
              }}
            />
          )}
        >
          <Window broken={broken} />
        </ErrorBoundary>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));

    expect(screen.getByText('워크스페이스')).toBeTruthy();
  });
});
