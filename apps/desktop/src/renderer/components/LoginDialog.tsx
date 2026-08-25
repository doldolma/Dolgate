// 워크스페이스 위에 띄우는 로그인 창.
//
// 계정 없이 쓰는 중에 로그인할 길은 여러 곳에서 열린다(상단 바 표시, 공유 안내). 그 자리마다
// 작은 로그인 판을 다시 만들면 오류 표시·서버 설정·브라우저 대기와 취소가 곳곳에 복제된다 —
// **로그인 화면을 통째로 여기 넣는다.**
//
// 페이지로 보내지 않는 이유는 그러면 워크스페이스가 언마운트되기 때문이다. 터미널을 띄운 채
// 로그인하러 갔다가 돌아왔을 때 그것들이 살아 있는지는 새로 짊어질 위험이고, 모달이면 뒤에
// 그대로 있다.
//
// "로그인 건너뛰기" 는 여기서 **그냥 닫기**다. 이미 그 상태이므로 다시 고르는 것은 무해하고,
// 사용자에게는 "지금은 안 할래" 라는 한 번의 동작으로 읽힌다.

import { DialogBackdrop } from './DialogBackdrop';
import { LoginGate } from './LoginGate';
import type { AuthState } from '@shared';

interface LoginDialogProps {
  open: boolean;
  authState: AuthState;
  serverUrl: string;
  hasServerUrlOverride: boolean;
  onClose: () => void;
  onBeginLogin: () => Promise<void>;
  onReopenBrowserLogin: () => Promise<void>;
  onCancelBrowserLogin: () => Promise<void>;
  onSaveServerUrl: (serverUrl: string) => Promise<void>;
  onResetServerUrl: () => Promise<void>;
}

export function LoginDialog({
  open,
  authState,
  serverUrl,
  hasServerUrlOverride,
  onClose,
  onBeginLogin,
  onReopenBrowserLogin,
  onCancelBrowserLogin,
  onSaveServerUrl,
  onResetServerUrl,
}: LoginDialogProps) {
  if (!open) {
    return null;
  }

  // 브라우저 로그인을 기다리는 동안에는 바깥을 눌러도 닫지 않는다 — 취소가 그 안에 있고,
  // 실수로 닫으면 무엇을 기다리는지 알 길이 사라진다.
  const isPendingBrowserLogin = authState.status === 'authenticating';

  return (
    <DialogBackdrop
      data-testid="login-dialog-backdrop"
      dismissDisabled={isPendingBrowserLogin}
      onDismiss={onClose}
    >
      <div
        className="w-[min(34rem,calc(100vw-2rem))]"
        role="dialog"
        aria-modal="true"
      >
        <LoginGate
          authState={authState}
          isSyncBootstrapping={false}
          serverUrl={serverUrl}
          hasServerUrlOverride={hasServerUrlOverride}
          isLoadingServerUrl={false}
          onBeginLogin={onBeginLogin}
          onReopenBrowserLogin={onReopenBrowserLogin}
          onCancelBrowserLogin={onCancelBrowserLogin}
          onSaveServerUrl={onSaveServerUrl}
          onResetServerUrl={onResetServerUrl}
          onStartLocalOnly={async () => onClose()}
        />
      </div>
    </DialogBackdrop>
  );
}
