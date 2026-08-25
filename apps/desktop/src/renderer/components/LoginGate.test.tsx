import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  LoginGate,
  resolveLoginGateActionLabel,
  resolveLoginGateStatusMessage,
  shouldDisableLoginGatePrimaryAction
} from './LoginGate';
import { getServerUrlValidationMessage } from '../../common/shared-messages';

describe('LoginGate', () => {
  it('disables the login action while loading or sync bootstrap is in flight', () => {
    expect(
      shouldDisableLoginGatePrimaryAction({
        authStatus: 'authenticating',
        isSyncBootstrapping: false,
        isLoadingServerUrl: false,
        isSubmitting: false,
        serverUrlValidationMessage: null
      })
    ).toBe(false);
    expect(
      shouldDisableLoginGatePrimaryAction({
        authStatus: 'loading',
        isSyncBootstrapping: false,
        isLoadingServerUrl: false,
        isSubmitting: false,
        serverUrlValidationMessage: null
      })
    ).toBe(true);
  });

  it('does not disable the login action only because login server settings are still loading', () => {
    expect(
      shouldDisableLoginGatePrimaryAction({
        authStatus: 'unauthenticated',
        isSyncBootstrapping: false,
        isLoadingServerUrl: true,
        isSubmitting: false,
        serverUrlValidationMessage: null
      })
    ).toBe(false);
  });

  it('prefers the explicit retry action label when provided', () => {
    expect(resolveLoginGateActionLabel('authenticated', '동기화 다시 시도')).toBe('동기화 다시 시도');
    expect(resolveLoginGateActionLabel('authenticating')).toBe('브라우저 다시 열기');
  });

  it('shows a sync status message only while workspace sync bootstrap is running', () => {
    expect(resolveLoginGateStatusMessage(true)).toBe('최신 데이터 동기화 중...');
    expect(resolveLoginGateStatusMessage(false)).toBeNull();
  });

  it('validates the advanced login server URL as an absolute root URL', () => {
    expect(getServerUrlValidationMessage('ssh.doldolma.com/path')).toBe(
      '로그인 서버 주소는 http:// 또는 https:// 로 시작하는 절대 URL이어야 합니다.'
    );
    expect(getServerUrlValidationMessage('https://ssh.custom.example.com')).toBeNull();
  });

  it('renders the inline sync status text during sync bootstrap', () => {
    render(
      <LoginGate
        authState={{ status: 'authenticated', session: null, errorMessage: null }}
        isSyncBootstrapping={true}
        serverUrl="https://ssh.doldolma.com"
        hasServerUrlOverride={false}
        isLoadingServerUrl={false}
        onBeginLogin={vi.fn().mockResolvedValue(undefined)}
        onSaveServerUrl={vi.fn().mockResolvedValue(undefined)}
        onResetServerUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText('최신 데이터 동기화 중...')).toBeInTheDocument();
  });

  it('keeps the primary login action enabled when hidden server settings are invalid', () => {
    render(
      <LoginGate
        authState={{ status: 'unauthenticated', session: null, errorMessage: null }}
        isSyncBootstrapping={false}
        serverUrl=""
        hasServerUrlOverride={false}
        isLoadingServerUrl={false}
        onBeginLogin={vi.fn().mockResolvedValue(undefined)}
        onSaveServerUrl={vi.fn().mockResolvedValue(undefined)}
        onResetServerUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(
      screen.getByRole('button', { name: '브라우저로 로그인하기' })
    ).toBeEnabled();
  });

  it('keeps the primary login action enabled while login server settings are loading', () => {
    render(
      <LoginGate
        authState={{ status: 'unauthenticated', session: null, errorMessage: null }}
        isSyncBootstrapping={false}
        serverUrl="https://ssh.doldolma.com"
        hasServerUrlOverride={false}
        isLoadingServerUrl={true}
        onBeginLogin={vi.fn().mockResolvedValue(undefined)}
        onSaveServerUrl={vi.fn().mockResolvedValue(undefined)}
        onResetServerUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(
      screen.getByRole('button', { name: '브라우저로 로그인하기' })
    ).toBeEnabled();
  });

  it('disables the primary action when advanced server settings are open with an invalid url', () => {
    render(
      <LoginGate
        authState={{ status: 'unauthenticated', session: null, errorMessage: null }}
        isSyncBootstrapping={false}
        serverUrl="https://ssh.doldolma.com"
        hasServerUrlOverride={false}
        isLoadingServerUrl={false}
        onBeginLogin={vi.fn().mockResolvedValue(undefined)}
        onSaveServerUrl={vi.fn().mockResolvedValue(undefined)}
        onResetServerUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.click(
      screen.getByRole('button', { name: '로그인 서버 설정 열기' })
    );
    fireEvent.change(screen.getByPlaceholderText('https://ssh.example.com'), {
      target: { value: 'invalid-host/path' }
    });

    expect(
      screen.getByRole('button', { name: '브라우저로 로그인하기' })
    ).toBeDisabled();
    expect(
      screen.getByText(
        '로그인 서버 주소는 http:// 또는 https:// 로 시작하는 절대 URL이어야 합니다.'
      )
    ).toBeInTheDocument();
  });

  it('saves the edited login server url via the 저장 button', async () => {
    const onSaveServerUrl = vi.fn().mockResolvedValue(undefined);
    render(
      <LoginGate
        authState={{ status: 'unauthenticated', session: null, errorMessage: null }}
        isSyncBootstrapping={false}
        serverUrl="https://ssh.doldolma.com"
        hasServerUrlOverride={false}
        isLoadingServerUrl={false}
        onBeginLogin={vi.fn().mockResolvedValue(undefined)}
        onSaveServerUrl={onSaveServerUrl}
        onResetServerUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '로그인 서버 설정 열기' }));

    // 변경 전에는 저장 버튼이 비활성(저장할 변경 없음).
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('https://ssh.example.com'), {
      target: { value: 'https://ssh.custom.example.com' }
    });

    const saveButton = screen.getByRole('button', { name: '저장' });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(onSaveServerUrl).toHaveBeenCalledWith('https://ssh.custom.example.com');
    });
  });

  it('renders inline svg icons for the settings and browser login actions', () => {
    render(
      <LoginGate
        authState={{ status: 'unauthenticated', session: null, errorMessage: null }}
        isSyncBootstrapping={false}
        serverUrl="https://ssh.doldolma.com"
        hasServerUrlOverride={false}
        isLoadingServerUrl={false}
        onBeginLogin={vi.fn().mockResolvedValue(undefined)}
        onSaveServerUrl={vi.fn().mockResolvedValue(undefined)}
        onResetServerUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const settingsButton = screen.getByRole('button', { name: '로그인 서버 설정 열기' });
    const loginButton = screen.getByRole('button', { name: '브라우저로 로그인하기' });

    expect(settingsButton.querySelector('svg')).not.toBeNull();
    expect(loginButton.querySelector('svg')).not.toBeNull();
    expect(settingsButton).not.toHaveTextContent('⚙');
    expect(loginButton).not.toHaveTextContent('↗');
  });

  it('shows reopen and cancel actions while waiting for browser login completion', async () => {
    const onReopenBrowserLogin = vi.fn().mockResolvedValue(undefined);
    const onCancelBrowserLogin = vi.fn().mockResolvedValue(undefined);

    render(
      <LoginGate
        authState={{
          status: 'authenticating',
          session: null,
          errorMessage: null
        }}
        isSyncBootstrapping={false}
        serverUrl="https://ssh.doldolma.com"
        hasServerUrlOverride={true}
        isLoadingServerUrl={false}
        onBeginLogin={vi.fn().mockResolvedValue(undefined)}
        onReopenBrowserLogin={onReopenBrowserLogin}
        onCancelBrowserLogin={onCancelBrowserLogin}
        onSaveServerUrl={vi.fn().mockResolvedValue(undefined)}
        onResetServerUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByRole('button', { name: '브라우저 다시 열기' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '취소' })).toBeEnabled();

    // 브라우저 로그인 대기 중에는 톱니바퀴(서버 설정)를 숨겨, 왜 변경이 막히는지 헷갈리지 않게 한다.
    expect(
      screen.queryByRole('button', { name: '로그인 서버 설정 열기' })
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '브라우저 다시 열기' }));
    await waitFor(() => {
      expect(onReopenBrowserLogin).toHaveBeenCalledTimes(1);
    });

    // 취소는 재열기가 끝날 때까지 disabled 다 — 호출만 기다리면 눌리지 않는 버튼을 누른다.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '취소' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    await waitFor(() => {
      expect(onCancelBrowserLogin).toHaveBeenCalledTimes(1);
    });
  });

  // 로그인을 건너뛰는 길. 로그인이 주고 이것이 부다 — 대등하게 두면 "일단 건너뛰기" 를
  // 누르는 사람이 늘어나는데, 폰에서는 로그인이 필수라 거기서 다시 막힌다.
  it('로그인을 건너뛰는 버튼을 그린다', async () => {
    const onStartLocalOnly = vi.fn().mockResolvedValue(undefined);
    render(
      <LoginGate
        authState={{ status: 'unauthenticated', session: null, errorMessage: null }}
        isSyncBootstrapping={false}
        serverUrl="https://ssh.doldolma.com"
        hasServerUrlOverride={false}
        isLoadingServerUrl={false}
        onBeginLogin={vi.fn().mockResolvedValue(undefined)}
        onSaveServerUrl={vi.fn().mockResolvedValue(undefined)}
        onResetServerUrl={vi.fn().mockResolvedValue(undefined)}
        onStartLocalOnly={onStartLocalOnly}
      />
    );

    // "건너뛰기" 가 "지금 안 할 뿐 나중에 할 수 있다" 를 담고 있어서 덧붙일 설명이 없다.
    fireEvent.click(screen.getByText('로그인 건너뛰기'));
    await waitFor(() => expect(onStartLocalOnly).toHaveBeenCalledTimes(1));
  });

  // 브라우저 로그인을 기다리는 동안에는 이 길을 감춘다 — 그때 누르면 진행 중인 로그인이
  // 무엇이 되는지 알 수 없다.
  it('브라우저 로그인을 기다리는 동안에는 그 버튼을 감춘다', () => {
    render(
      <LoginGate
        authState={{ status: 'authenticating', session: null, errorMessage: null }}
        isSyncBootstrapping={false}
        serverUrl="https://ssh.doldolma.com"
        hasServerUrlOverride={false}
        isLoadingServerUrl={false}
        onBeginLogin={vi.fn().mockResolvedValue(undefined)}
        onSaveServerUrl={vi.fn().mockResolvedValue(undefined)}
        onResetServerUrl={vi.fn().mockResolvedValue(undefined)}
        onStartLocalOnly={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.queryByText('로그인 건너뛰기')).not.toBeInTheDocument();
  });

  // 메인에서 던진 오류는 `Error invoking remote method '...': Error: ` 가 앞에 붙어서 온다.
  // 그대로 보여 주면 사용자가 읽을 것이 아니라 우리 내부 사정이 화면에 뜬다.
  it('로그인 실패 문구에서 IPC 래퍼 접두사를 벗긴다', async () => {
    render(
      <LoginGate
        authState={{ status: 'unauthenticated', session: null, errorMessage: null }}
        isSyncBootstrapping={false}
        serverUrl="https://ssh.doldolma.com"
        hasServerUrlOverride={false}
        isLoadingServerUrl={false}
        onBeginLogin={vi
          .fn()
          .mockRejectedValue(
            new Error(
              "Error invoking remote method 'auth:begin-browser-login': Error: 이 로그인 서버는 너무 오래됐습니다.",
            ),
          )}
        onSaveServerUrl={vi.fn().mockResolvedValue(undefined)}
        onResetServerUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.click(screen.getByText('브라우저로 로그인하기'));

    await waitFor(() =>
      expect(
        screen.getByText('이 로그인 서버는 너무 오래됐습니다.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/invoking remote method/)).not.toBeInTheDocument();
  });
});
