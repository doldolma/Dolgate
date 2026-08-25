import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoginDialog } from './LoginDialog';

function renderDialog(overrides: Partial<Record<string, unknown>> = {}) {
  const props = {
    open: true,
    authState: {
      status: 'local-only' as const,
      session: null,
      errorMessage: null,
    },
    serverUrl: 'https://ssh.doldolma.com',
    hasServerUrlOverride: false,
    onClose: vi.fn(),
    onBeginLogin: vi.fn().mockResolvedValue(undefined),
    onReopenBrowserLogin: vi.fn().mockResolvedValue(undefined),
    onCancelBrowserLogin: vi.fn().mockResolvedValue(undefined),
    onSaveServerUrl: vi.fn().mockResolvedValue(undefined),
    onResetServerUrl: vi.fn().mockResolvedValue(undefined),
  } as Record<string, unknown>;
  Object.assign(props, overrides);
  render(<LoginDialog {...(props as unknown as Parameters<typeof LoginDialog>[0])} />);
  return props as unknown as {
    onClose: ReturnType<typeof vi.fn>;
    onBeginLogin: ReturnType<typeof vi.fn>;
  };
}

describe('LoginDialog', () => {
  // 자리마다 작은 로그인 판을 만들면 오류 표시·서버 설정·브라우저 대기가 곳곳에 복제된다.
  // 로그인 화면을 통째로 넣는 이유다.
  it('로그인 화면을 그대로 담는다', () => {
    renderDialog();
    expect(screen.getByText('브라우저로 로그인하기')).toBeInTheDocument();
  });

  // 이미 계정 없이 쓰는 중이므로 그 버튼은 여기서 그냥 닫기다 — 맥락별로 문구를 나누지 않는다.
  it('로그인 건너뛰기를 누르면 그대로 닫힌다', async () => {
    const props = renderDialog();
    fireEvent.click(screen.getByText('로그인 건너뛰기'));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
    expect(props.onBeginLogin).not.toHaveBeenCalled();
  });

  it('닫혀 있으면 아무것도 그리지 않는다', () => {
    renderDialog({ open: false });
    expect(screen.queryByTestId('login-dialog-backdrop')).not.toBeInTheDocument();
  });
});
