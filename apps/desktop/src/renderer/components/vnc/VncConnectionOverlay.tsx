import { useEffect, useMemo } from 'react';
import { isSshHostRecord, isVncHostRecord } from '@shared';
import { useTranslation } from 'react-i18next';

import {
  resolveHostTailnetId,
  resolveTailnetTargetAddress,
} from '../../lib/host-tailnet';
import { acquireTailnetWatch } from '../../services/desktop/tailnet-watch';
import { useAppStore } from '../../store/appStore';
import { ConnectionStatusOverlay } from '../ConnectionStatusOverlay';
import { resolveConnectionStages } from '../terminal-workspace/connectionStages';

interface VncConnectionOverlayProps {
  sessionId: string;
}

/**
 * VNC 세션의 연결 진행·실패를 덮어 보여준다.
 *
 * RDP 와 같은 `ConnectionStatusOverlay` 를 쓴다. 예전에는 캔버스가 자기 오류 문구만 붉게 그렸는데,
 * 그러면 **다시 시도할 방법이 없고** 재연결 중이라는 것도 보이지 않았다 — 붙어 있던 세션이 끊기면
 * 화면만 멈춘 것처럼 보였다.
 *
 * 단계 목록도 RDP 와 같은 해석기에서 받는다. 한 줄 진행 문구로는 "연결하는 중" 밖에 말할 수 없어서,
 * tailnet 인증이 아직 안 끝났거나 넷맵에 대상이 없는 경우가 그냥 멈춘 것처럼 보였다.
 *
 * **경유하는 SSH 호스트의 tailnet 도 이 화면의 일이다.** VNC 호스트 자신에는 tailnet 이 없어도
 * 터널이 경유 호스트의 tailnet 설정을 타므로(`ipc/vnc.ts` 의 `resolveTailnetRoute`), 노드가 올라오고
 * 브라우저 로그인을 기다리는 것은 그쪽이다 — 그것을 안 보여주면 이 화면은 이유 없이 멈춘다.
 */
export function VncConnectionOverlay({ sessionId }: VncConnectionOverlayProps) {
  const { t: translate } = useTranslation();
  const tab = useAppStore((state) =>
    state.tabs.find((item) => item.sessionId === sessionId),
  );
  const hosts = useAppStore((state) => state.hosts);
  const host = tab?.hostId
    ? hosts.find((item) => item.id === tab.hostId)
    : undefined;
  // 어느 tailnet 을 기다리는지·넷맵에서 어느 기기를 찾는지는 종류마다 다르다. 그 판정은 한 곳에
  // 모아 두고 여기서는 쓰기만 한다(터널을 쓰면 둘 다 경유 호스트를 가리킨다).
  const tailnetId = resolveHostTailnetId(host, hosts);
  const tailnetStatus = useAppStore((state) =>
    tailnetId ? state.tailnetStatuses[tailnetId] : undefined,
  );
  const retryVncConnection = useAppStore((state) => state.retryVncConnection);
  // Close 는 탭을 닫는다(터미널 오버레이와 같은 뜻이다). 넘기지 않으면 버튼이 그려지긴
  // 하는데 아무 일도 하지 않는다 — 실제로 그 상태로 나가 있었다.
  const disconnectTab = useAppStore((state) => state.disconnectTab);
  const openExternalUrl = useAppStore((state) => state.openExternalUrl);

  // 경유 SSH 호스트의 이름. 관문 라벨에 넣어 "어디를 거치는 중" 인지 말한다.
  const tunnelLabel = useMemo(() => {
    if (!host || !isVncHostRecord(host)) {
      return null;
    }
    const tunnelHostId = host.sshTunnelHostId?.trim();
    if (!tunnelHostId) {
      return null;
    }
    const tunnelHost = hosts.find((item) => item.id === tunnelHostId);
    return tunnelHost && isSshHostRecord(tunnelHost)
      ? tunnelHost.label?.trim() || tunnelHost.hostname
      : // 지워진 호스트다. 접속 경로가 그 이유를 오류로 말하므로 여기서는 관문만 세운다.
        translate('vnc.overlay.tunnelUnknown');
  }, [host, hosts, translate]);

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
        targetAddress: resolveTailnetTargetAddress(host, hosts),
        hostKind: host?.kind,
        tailnetStatus,
        tunnelLabel,
        // VNC 도 실패 계층을 나누지 않는다. 단계 목록만으로도 tailnet 에서 막혔는지 원격이
        // 거절했는지 갈린다.
        failureLayer: null,
        // 오류 문구는 헤드라인이 이미 보여준다. 단계에도 넣으면 같은 문장이 두 번 나온다.
      }),
    [host, hosts, tab, tailnetId, tailnetStatus, tunnelLabel],
  );

  if (!tab || (host && !isVncHostRecord(host))) {
    return null;
  }
  // 붙어 있으면 덮지 않는다. 재연결 중(reconnect)이면 status 가 connecting 이라 여기 걸린다.
  if (tab.status === 'connected') {
    return null;
  }

  const failed = tab.status === 'error';
  const message = tab.connectionProgress?.message ?? tab.errorMessage ?? '';
  /**
   * 지금 열어야 할 인증 링크.
   *
   * 누가 그 인증을 시작했는지는 상관없다 — 노드가 tailnet 단위로 공유되므로 링크도 공유 상태
   * 하나에서 온다(터미널 창과 같은 규칙).
   *
   * 실패로 앉은 화면에서도 보여준다. 로그인을 마치면 재시도가 곧바로 통하므로, 그 링크를 감추면
   * 사용자는 할 수 있는 일을 못 찾는다.
   */
  const tailnetAuthUrl =
    tailnetStatus?.state === 'needsAuth' ? tailnetStatus.authUrl : undefined;

  return (
    <ConnectionStatusOverlay
      error={failed}
      title={
        failed
          ? translate('vnc.overlay.failedTitle')
          : translate('vnc.overlay.connectingTitle')
      }
      message={message}
      // 재시도는 같은 탭에 다시 붙는다(stableId 유지) — 자동 재연결과 같은 경로다.
      showRetry={failed}
      onClose={() => {
        void disconnectTab(sessionId);
      }}
      onRetry={() => {
        void retryVncConnection(sessionId);
      }}
      // 링크가 있으면 할 일은 브라우저로 돌아가는 것뿐이다.
      secondaryActionLabel={
        tailnetAuthUrl ? translate('misc.reopenBrowser') : undefined
      }
      onSecondaryAction={
        tailnetAuthUrl ? () => void openExternalUrl(tailnetAuthUrl) : undefined
      }
      stages={stages.length > 0 ? stages : null}
    />
  );
}
