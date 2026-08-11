import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

// 렌더 중 던진 오류를 여기서 멈추지 않으면 React 가 트리를 통째로 언마운트해 창이 빈 화면이 된다.
// 실제로 그런 사고가 있었다(옛 빌드가 동기화로 받은 RDP 호스트를 그리다 던졌다).

function Boom({ shouldThrow }: { shouldThrow: boolean }): React.ReactElement {
  if (shouldThrow) {
    throw new Error('레코드를 읽을 수 없음');
  }
  return <div>정상 내용</div>;
}

beforeEach(() => {
  // React 는 잡힌 오류도 콘솔에 다시 뱉는다. 테스트 출력만 조용하게 한다.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('던진 자식 대신 폴백을 그리고 트리를 살린다', () => {
    render(
      <div>
        <span>형제 요소</span>
        <ErrorBoundary fallback={(error) => <div>실패: {error.message}</div>}>
          <Boom shouldThrow />
        </ErrorBoundary>
      </div>,
    );

    expect(screen.getByText('실패: 레코드를 읽을 수 없음')).toBeTruthy();
    // 바운더리 밖은 그대로 살아 있어야 한다 — 이게 없으면 화면 전체가 사라진다.
    expect(screen.getByText('형제 요소')).toBeTruthy();
  });

  it('정상일 때는 자식을 그대로 그린다', () => {
    render(
      <ErrorBoundary fallback={() => <div>실패</div>}>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('정상 내용')).toBeTruthy();
    expect(screen.queryByText('실패')).toBeNull();
  });

  it('폴백의 reset 으로 다시 그리기를 시도한다', () => {
    function Harness() {
      const [broken, setBroken] = useState(true);
      return (
        <ErrorBoundary
          fallback={(_error, reset) => (
            <button
              type="button"
              onClick={() => {
                setBroken(false);
                reset();
              }}
            >
              다시 시도
            </button>
          )}
        >
          <Boom shouldThrow={broken} />
        </ErrorBoundary>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));

    expect(screen.getByText('정상 내용')).toBeTruthy();
  });

  it('resetKey 가 바뀌면 스스로 오류를 푼다', () => {
    // 호스트를 바꿨는데 앞 호스트의 오류 화면이 그대로 남으면 무엇이 잘못됐는지 알 수 없다.
    function Harness() {
      const [key, setKey] = useState('host-1');
      return (
        <>
          <button type="button" onClick={() => setKey('host-2')}>
            다음 호스트
          </button>
          <ErrorBoundary resetKey={key} fallback={() => <div>실패</div>}>
            <Boom shouldThrow={key === 'host-1'} />
          </ErrorBoundary>
        </>
      );
    }

    render(<Harness />);
    expect(screen.getByText('실패')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '다음 호스트' }));

    expect(screen.getByText('정상 내용')).toBeTruthy();
  });
});
