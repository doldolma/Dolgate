import { useEffect, useMemo } from 'react';
import { isRdpHostRecord } from '@shared';
import { useAppStore } from '../../store/appStore';
import { acquireTailnetWatch } from '../../services/desktop/tailnet-watch';
import { ConnectionStatusOverlay } from '../ConnectionStatusOverlay';
import { resolveConnectionStages } from '../terminal-workspace/connectionStages';
import { useTranslation } from 'react-i18next';

interface RdpConnectionOverlayProps {
  sessionId: string;
}

/**
 * RDP 세션의 연결 진행·실패를 덮어 보여준다.
 *
 * 터미널(`TerminalConnectionOverlay`)과 컨테이너 화면이 쓰는 `ConnectionStatusOverlay` 를 그대로
 * 쓴다 — 새로 만들지 않는 이유는 그 컴포넌트가 터미널을 모르는 순수 표시 컴포넌트이고, tailnet
 * 처럼 별도 계층을 거치는 연결을 위한 `stages`·`notes` 를 이미 갖고 있기 때문이다.
 *
 * **메인 창 pane 에만 얹는다.** 보조 모니터 창은 별도 BrowserWindow 라 이 스토어(탭·호스트)가
 * 없다 — 거기서는 캔버스가 자기 오류 문구를 그대로 쓴다.
 */
export function RdpConnectionOverlay({ sessionId }: RdpConnectionOverlayProps) {
  const { t: translate } = useTranslation();
  const tab = useAppStore((state) =>
    state.tabs.find((item) => item.sessionId === sessionId),
  );
  const host = useAppStore((state) =>
    tab?.hostId ? state.hosts.find((item) => item.id === tab.hostId) : undefined,
  );
  const tailnetId =
    host && isRdpHostRecord(host) ? host.tailnetId?.trim() : undefined;
  const tailnetStatus = useAppStore((state) =>
    tailnetId ? state.tailnetStatuses[tailnetId] : undefined,
  );
  const retryRdpConnection = useAppStore((state) => state.retryRdpConnection);

  // 아직 붙지 못한 tailnet 세션인 동안만 상태를 읽는다. 붙은 연결에는 이 왕복이 얹히지 않는다.
  //
  // 실패한 경우만 보면 안 된다 — 같은 tailnet 을 쓰는 세션을 하나 더 열면 그 세션은 진행 중인
  // 인증에 합류하는데, 진행 문구는 시도를 시작한 세션에만 간다.
  const watching = Boolean(tailnetId) && tab?.status !== 'connected';
  useEffect(() => {
    if (!watching) {
      return;
    }
    return acquireTailnetWatch();
  }, [watching]);

  const stages = useMemo(
    () =>
      resolveConnectionStages({
        tab,
        hasTailscale: Boolean(tailnetId),
        // 대상 주소로 넷맵에서 그 기기를 찾아 경로를 보여준다 — Tailscale 이 붙어 있어도 대상에
        // 못 가는 경우가 있고, 그것을 안 보여주면 "설정은 연결됨인데 왜 안 되지" 가 된다.
        targetAddress: host && isRdpHostRecord(host) ? host.hostname : undefined,
        hostKind: host?.kind,
        tailnetStatus,
        // RDP 는 실패 계층을 아직 나누지 않는다. 단계 목록만으로도 tailnet 에서 막혔는지
        // 원격이 거절했는지 갈린다.
        failureLayer: null,
        // 오류 문구는 헤드라인이 이미 보여준다. 단계에도 넣으면 같은 문장이 두 번 나온다.
      }),
    [host, tab, tailnetId, tailnetStatus],
  );

  if (!tab || tab.status === 'connected') {
    // 붙었으면 화면을 가리지 않는다.
    return null;
  }

  const failed = tab.status === 'error';
  const message = tab.connectionProgress?.message ?? tab.errorMessage ?? '';

  return (
    <ConnectionStatusOverlay
      error={failed}
      title={
        failed
          ? translate('rdp.overlay.failedTitle')
          : translate('rdp.overlay.connectingTitle')
      }
      message={message}
      // 재시도는 같은 탭에 다시 붙는다(stableId 유지) — 자동 재연결과 같은 경로다.
      showRetry={failed}
      onRetry={() => {
        void retryRdpConnection(sessionId);
      }}
      stages={stages.length > 0 ? stages : null}
    />
  );
}
