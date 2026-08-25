// 상단 바(세션 패널 토글 옆)의 Share 버튼.
//
// 예전에는 터미널 오른쪽 위에 알약으로 떠서 화면을 늘 가리고 있었다. 눌렀을 때 열리는 팝오버는
// **그대로**이고 자리만 상단 바로 옮겼다 — 창 단위 크롬에 붙으므로 터미널을 가리지 않는다.
//
// 팝오버 내용은 pane 헤더(분할 화면)와 같은 컴포넌트다. 다만 핸들러는 pane 컨트롤러가 아니라
// 스토어·레지스트리로 직접 간다: 상단 바는 pane 밖이라 컨트롤러의 ref 에 닿을 수 없다.
// 공유 시작에 필요한 첫 화면은 컨트롤러가 등록해 둔 훅(terminal-write-registry)에서 받는다.

import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store/appStore';
import { canShareSessionTab } from './terminalSessionHelpers';
import { captureTerminalShareSnapshot } from '../../lib/terminal-write-registry';
import { openOwnerChatWindow } from '../../services/desktop/session-shares';
import { TerminalSharePopover } from './TerminalSharePopover';

interface SessionShareChromeButtonProps {
  /** 지금 포커스된 터미널 세션(분할이면 그 pane). */
  sessionId: string;
  /** 계정 없이 쓰는 중인가 — 공유는 서버를 거치므로 그때는 못 한다. */
  isLocalOnly?: boolean;
  /** 그때 안내 아래에 둘 로그인 버튼. 로그인 창은 셸이 하나만 연다. */
  onRequestLogin?: () => void;
}

export function SessionShareChromeButton({
  sessionId,
  isLocalOnly = false,
  onRequestLogin,
}: SessionShareChromeButtonProps) {
  const { t: translate } = useTranslation();
  const tabs = useAppStore((state) => state.tabs);
  const hosts = useAppStore((state) => state.hosts);
  const startSessionShare = useAppStore((state) => state.startSessionShare);
  const setSessionShareInputEnabled = useAppStore(
    (state) => state.setSessionShareInputEnabled,
  );
  const stopSessionShare = useAppStore((state) => state.stopSessionShare);
  const [open, setOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  const tab = useMemo(
    () => tabs.find((entry) => entry.sessionId === sessionId) ?? null,
    [sessionId, tabs],
  );
  const host = useMemo(
    () => (tab?.hostId ? (hosts.find((entry) => entry.id === tab.hostId) ?? null) : null),
    [hosts, tab?.hostId],
  );

  // 공유할 수 없는 세션(tmux pane · 로컬 터미널)에는 버튼을 두지 않는다 — pane 헤더의 Share 와
  // 같은 규칙을 본다.
  if (!canShareSessionTab(tab)) {
    return null;
  }

  const share = tab?.sessionShare ?? null;

  return (
    <TerminalSharePopover
      variant="chrome"
      anchorRef={anchorRef}
      open={open}
      canStartShare={tab?.status === 'connected' && share?.status !== 'starting'}
      unavailableReason={
        isLocalOnly ? translate('sharePopover.needsAccount') : null
      }
      onRequestLogin={
        isLocalOnly && onRequestLogin
          ? () => {
              setOpen(false);
              onRequestLogin();
            }
          : undefined
      }
      shareCopyStatus={copyStatus}
      shareState={share}
      onToggle={() => {
        setOpen((current) => !current);
        setCopyStatus(null);
      }}
      onStartShare={() => {
        // 첫 화면이 없으면 시작하지 않는다 — 상대가 빈 화면을 보게 된다.
        const snapshot = captureTerminalShareSnapshot(sessionId);
        if (!snapshot || !tab) {
          return;
        }
        // 전송은 추측(호스트 종류)일 뿐이고 main 이 세션의 실제 전송으로 다시 판정한다 —
        // pane 헤더의 Share 와 같은 값을 넘긴다.
        void startSessionShare({
          sessionId,
          title: tab.title,
          transport: host?.kind === 'aws-ec2' ? 'aws-ssm' : 'ssh',
          ...snapshot,
        });
        setOpen(true);
        setCopyStatus(null);
      }}
      onCopyShareUrl={() => {
        if (!share?.shareUrl) {
          return;
        }
        // clipboard 가 없는 창(보안 컨텍스트 아님·테스트)에서 던지지 않게 한다.
        const write = navigator.clipboard?.writeText(share.shareUrl);
        if (!write) {
          setCopyStatus(translate('termView.linkCopyFailed'));
          return;
        }
        void write
          .then(() => setCopyStatus(translate('termView.linkCopied')))
          .catch(() => setCopyStatus(translate('termView.linkCopyFailed')));
      }}
      onSetInputEnabled={(inputEnabled) => {
        void setSessionShareInputEnabled(sessionId, inputEnabled);
      }}
      onOpenChatWindow={() => void openOwnerChatWindow(sessionId)}
      onStopShare={() => {
        void stopSessionShare(sessionId);
        setOpen(false);
      }}
      canOpenChatWindow
    />
  );
}
