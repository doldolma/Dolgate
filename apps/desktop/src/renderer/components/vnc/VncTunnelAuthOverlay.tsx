import { useEffect, useState } from 'react';

import { useAppStore } from '../../store/appStore';
import { TerminalInteractiveAuthOverlay } from '../terminal-workspace/TerminalInteractiveAuthOverlay';

interface VncTunnelAuthOverlayProps {
  sessionId: string;
}

/**
 * VNC 세션의 경유 SSH 터널이 묻는 인증(OTP 등)을 이 판 위에 띄운다.
 *
 * 터미널 판과 같은 카드를 쓴다(`TerminalInteractiveAuthOverlay`) — 화면을 하나 더 만들 이유가
 * 없고, "누가 묻는지" 한 줄까지 같은 규칙으로 보여 준다. 다른 점은 답이 가는 길뿐이다: 터널은
 * 포워딩 서비스가 열기 때문에 endpointId 로 답해야 하는데, 그 판정은 스토어가 한다
 * (`respondInteractiveAuth` — vncTunnel 은 endpointId 로 보낸다).
 *
 * 연결 진행 카드(`VncConnectionOverlay`, z-[3])보다 위에 그려야 한다. 카드 자체가 z-20 이라 이
 * 컴포넌트를 그 뒤에 두면 위에 올라온다 — 아래로 깔리면 사용자는 입력창을 볼 수 없다.
 */
export function VncTunnelAuthOverlay({ sessionId }: VncTunnelAuthOverlayProps) {
  const interactiveAuth = useAppStore(
    (state) =>
      state.pendingInteractiveAuths.find(
        (auth) => auth.source === 'vncTunnel' && auth.sessionId === sessionId,
      ) ?? null,
  );
  const respondInteractiveAuth = useAppStore(
    (state) => state.respondInteractiveAuth,
  );
  const reopenInteractiveAuthUrl = useAppStore(
    (state) => state.reopenInteractiveAuthUrl,
  );
  const clearPendingInteractiveAuth = useAppStore(
    (state) => state.clearPendingInteractiveAuth,
  );
  const disconnectTab = useAppStore((state) => state.disconnectTab);
  const [promptResponses, setPromptResponses] = useState<string[]>([]);

  // 새 질문이 오면 칸을 비운다. 재시도(같은 세션, 새 challengeId)에서 앞의 코드가 남아 있으면
  // 이미 무효한 코드를 그대로 보내게 된다 — TOTP 는 한 번 쓰면 끝이다.
  const challengeId = interactiveAuth?.challengeId ?? null;
  const promptCount = interactiveAuth?.prompts.length ?? 0;
  useEffect(() => {
    setPromptResponses(
      challengeId ? Array.from({ length: promptCount }, () => '') : [],
    );
  }, [challengeId, promptCount]);

  if (!interactiveAuth) {
    return null;
  }

  return (
    <TerminalInteractiveAuthOverlay
      interactiveAuth={interactiveAuth}
      promptResponses={promptResponses}
      // 저장된 비밀번호 지목은 넘기지 않는다 — 그 대입은 세션 경로에서만 코어가 처리한다.
      onPromptResponseChange={(index, value) => {
        setPromptResponses((current) => {
          const next = [...current];
          next[index] = value;
          return next;
        });
      }}
      onSubmit={() => {
        void respondInteractiveAuth(interactiveAuth.challengeId, promptResponses);
      }}
      onCopyApprovalUrl={async () => {
        await navigator.clipboard.writeText(interactiveAuth.approvalUrl ?? '');
      }}
      onReopenApprovalUrl={() => {
        void reopenInteractiveAuthUrl(interactiveAuth.challengeId);
      }}
      onClose={() => {
        // 인증을 그만두면 이 연결도 그만두는 것이다. 카드만 감추면 코어는 계속 답을 기다리고
        // 화면은 "연결 중" 에 앉아 있다 — 진행 카드의 Close 와 같은 길로 보낸다.
        void disconnectTab(sessionId);
        clearPendingInteractiveAuth(interactiveAuth.challengeId);
      }}
    />
  );
}
