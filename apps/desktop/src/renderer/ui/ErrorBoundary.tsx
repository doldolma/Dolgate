import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * 렌더 중 던진 오류를 여기서 멈춘다.
 *
 * **왜 필요한가:** React 는 렌더 중 예외를 잡아 주는 곳이 없으면 트리를 통째로 언마운트한다.
 * 그래서 호스트 한 줄을 그리다 난 오류가 창 전체를 빈 화면으로 만든다 — 1.8.10 이 RDP 호스트를
 * 동기화로 받고 `username.trim()` 에서 던져 앱이 아예 뜨지 않았다. 데이터는 기기 사이에서
 * 동기화되므로 "이 빌드가 모르는 모양" 은 앞으로도 온다. 그때 깨지는 범위를 그 자리로 묶는다.
 *
 * 자리마다 폴백 모양이 달라야 한다(목록 한 줄 / 패널 / 창 전체). 그래서 폴백은 함수로 받는다.
 */
export interface ErrorBoundaryProps {
  children: ReactNode;
  /** 폴백 화면. reset 을 부르면 다시 그리기를 시도한다. */
  fallback: (error: Error, reset: () => void) => ReactNode;
  /**
   * 값이 바뀌면 오류 상태를 스스로 푼다.
   *
   * 없으면 한 번 실패한 자리는 사용자가 버튼을 누를 때까지 실패로 남는다 — 호스트를 바꿨는데
   * 앞 호스트의 오류 화면이 그대로 있으면 무엇이 잘못됐는지 알 수 없다.
   */
  resetKey?: string;
  /** 콘솔에 남길 이름. 어디서 터졌는지 구분하는 데 쓴다. */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 오류를 화면에만 두면 사용자가 옮겨 적어야 한다. 콘솔에도 스택과 함께 남긴다.
    console.error(`[error-boundary] ${this.props.label ?? 'unnamed'} 렌더 실패`, error, info);
  }

  componentDidUpdate(previous: Readonly<ErrorBoundaryProps>) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (error) {
      return this.props.fallback(error, this.reset);
    }
    return this.props.children;
  }
}
