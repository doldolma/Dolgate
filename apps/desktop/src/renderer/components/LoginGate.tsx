import type { AuthState } from '@shared';

interface LoginGateProps {
  authState: AuthState;
  isSyncBootstrapping: boolean;
  onBeginLogin: () => Promise<void>;
  actionLabel?: string;
  onAction?: () => Promise<void>;
}

export function LoginGate({ authState, isSyncBootstrapping, onBeginLogin, actionLabel, onAction }: LoginGateProps) {
  const handleAction = onAction ?? onBeginLogin;
  const label = actionLabel ?? (authState.status === 'authenticating' ? '브라우저 로그인 대기 중...' : '브라우저로 로그인하기');
  return (
    <div className="login-gate">
      <div className="login-gate__card">
        <div className="login-gate__eyebrow">dolssh</div>
        {authState.errorMessage ? <div className="login-gate__error">{authState.errorMessage}</div> : null}
        <button
          type="button"
          className="login-gate__button"
          disabled={authState.status === 'loading' || authState.status === 'authenticating' || isSyncBootstrapping}
          onClick={async () => handleAction()}
        >
          <span>{label}</span>
          <span className="login-gate__button-icon" aria-hidden="true">
            ↗
          </span>
        </button>
      </div>
    </div>
  );
}
