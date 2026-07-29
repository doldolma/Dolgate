import type { TailnetStatus, TerminalTab } from '@shared';
import { t } from '../../i18n';

/**
 * 연결이 무엇을 거치고 있는지 단계로 나눈 것.
 *
 * 진행을 한 줄 문구로 보여주면 새 단계가 앞 단계를 덮어써서, 지나간 것은 사라지고 지금 것만
 * 남는다. 단계가 빨리 지나가면 사용자는 아무것도 못 본 것과 같고, 실패했을 때 어디까지 갔는지도
 * 알 수 없다 — Tailscale 때문에 못 붙은 것인지 SSH 가 거절한 것인지 구분할 방법이 없었다.
 *
 * 그래서 지나간 단계를 남긴다. 각 단계는 스스로 상태를 갖고, 실패는 그 단계에 붙는다.
 */
export type ConnectionStageState =
  /** 아직 시작하지 않음. 앞 단계가 끝나야 시작한다. */
  | 'pending'
  /** 진행 중. */
  | 'active'
  /** 사람이 무언가 해야 진행된다(브라우저 로그인, 관리자 승인, 키 신뢰). */
  | 'blocked'
  | 'done'
  | 'failed'
  /** 진행은 됐지만 짚어 둘 것이 있다(릴레이 서버 문제 등). */
  | 'warn';

export interface ConnectionStage {
  /** 목록 안에서 고유한 값. 화면이 키로 쓴다. */
  id: string;
  /** 어느 계층인지. 화면이 묶어서 보여준다. */
  group: 'tailscale' | 'host';
  label: string;
  state: ConnectionStageState;
  /** 그 단계에 대해 더 말할 것(사람이 할 일, 실패 이유, 관찰값). */
  detail?: string;
}

/** 실패가 어느 계층의 것인지. 문구가 아니라 이 구분으로 단계에 붙인다. */
export type ConnectionFailureLayer = 'tailscale' | 'hostKey' | 'ssh' | null;

/**
 * Tailscale 계층의 단계들.
 *
 * 상태 하나(`state`)만 보여주면 "연결하는 중" 밖에 말할 수 없다. 노드가 붙는 데는 여러 관문이
 * 있고(등록이 유효한지, 인증이 필요한지, 기기 목록을 받았는지) 각 관문에서 막힐 수 있다.
 * 어디서 막혔는지가 사용자가 할 일을 정한다.
 */
export function resolveTailscaleStages(
  status: TailnetStatus | undefined,
  failed: boolean,
  target?: string,
): ConnectionStage[] {
  const state = status?.state;
  // 백엔드가 실제로 상태를 만들었는지. 'starting' 에는 아직 아무것도 없는 구간(NoState)이 섞여
  // 있어서, 그것까지 시작 완료로 쓰면 인터넷이 없는데도 ✓ 가 뜬다.
  const started =
    state === 'running' || state === 'needsAuth' || state === 'needsApproval';
  // 코어의 판정. 표시도 관문과 같은 기준을 써야 "연결됨" 인데 못 붙는 화면이 안 생긴다.
  const authorized = status?.ready === true;
  const expired = status?.expired === true;
  const peers = status?.peers?.length ?? 0;

  // 1) 노드가 떠 있는지. 앱이 tailnet 안의 기기로 참여하는 첫 관문이다.
  const nodeStage: ConnectionStage = {
    id: 'tailscale-node',
    group: 'tailscale',
    label: t('connectStages.tailscaleNode'),
    state: started ? 'done' : failed ? 'failed' : 'active',
    detail: status?.backendState ?? undefined,
  };

  // 2) 등록이 아직 유효한지. 만료는 상태로 드러나지 않을 때가 많아서, 드러났으면 그대로 말한다.
  const registrationStage: ConnectionStage = {
    id: 'tailscale-registration',
    group: 'tailscale',
    label: t('connectStages.tailscaleRegistration'),
    state: expired ? 'failed' : authorized ? 'done' : started ? 'active' : 'pending',
    detail: expired
      ? t('connectStages.tailscaleExpiredDetail')
      : status?.keyExpiry
        ? t('connectStages.tailscaleKeyExpiryDetail', { at: formatExpiry(status.keyExpiry) })
        : undefined,
  };

  // 3) 사람이 해야 하는 인증. 링크가 오기까지 몇 초 걸리므로 그 사이를 따로 말한다 — "로그인
  //    하세요" 라고 해 놓고 누를 것이 없으면 사용자는 앱이 멈춘 줄 안다.
  const authStage: ConnectionStage = {
    id: 'tailscale-auth',
    group: 'tailscale',
    label: t('connectStages.tailscaleAuth'),
    state:
      state === 'needsAuth' || state === 'needsApproval'
        ? status?.authUrl || state === 'needsApproval'
          ? 'blocked'
          : 'active'
        : authorized
          ? 'done'
          : 'pending',
    detail:
      state === 'needsApproval'
        ? t('connectStages.tailscaleApprovalDetail')
        : state === 'needsAuth'
          ? status?.authUrl
            ? t('connectStages.tailscaleBrowserDetail')
            : t('connectStages.tailscaleLinkDetail')
          : undefined,
  };

  // 4) 컨트롤 플레인과 동기화되고 있는지.
  //
  //    이것이 지금까지 화면에 없어서 "연결됨인데 통신이 안 되는" 상태를 아무도 설명할 수 없었다.
  //    등록이 만료되면 컨트롤 플레인이 이 세션을 끊는데, 노드는 연결됨으로 남고 기기 목록까지
  //    낡은 값으로 유지된다. 기기 수는 그 자체로 신뢰할 수 없으므로 참고값으로만 붙인다.
  const networkStage: ConnectionStage = {
    id: 'tailscale-network',
    group: 'tailscale',
    label: t('connectStages.tailscaleSync'),
    state: status?.online === true ? 'done' : started ? 'active' : 'pending',
    detail:
      status?.online === true && peers > 0
        ? t('connectStages.tailscalePeersDetail', { count: peers })
        : status?.online === false && status.state === 'running'
          ? t('connectStages.tailscaleStaleDetail')
          : undefined,
  };

  const stages = [nodeStage, registrationStage, authStage, networkStage];

  // 5) 대상까지 갈 길이 있는지.
  //
  //    Tailscale 이 붙어 있어도 대상에 못 가는 경우가 있다 — 그 기기가 이 네트워크에 없거나,
  //    직결이 안 되는데 릴레이(DERP)마저 닿지 않을 때다. 이것을 안 보여주면 "설정은 연결됨인데
  //    왜 안 되지" 가 된다. 경로 정보는 이미 상태에 실려 온다.
  if (target) {
    stages.push(resolveTargetStage(target, status));
  }

  // 백엔드가 스스로 보고하는 문제. 상태가 정상으로 보이는데 통신이 안 되는 경우의 유일한 단서다.
  for (const [index, warning] of (status?.health ?? []).entries()) {
    stages.push({
      id: `tailscale-health-${index}`,
      group: 'tailscale',
      label: t('connectStages.tailscaleHealth'),
      state: 'warn',
      detail: warning,
    });
  }
  if (status?.error) {
    stages.push({
      id: 'tailscale-error',
      group: 'tailscale',
      label: t('connectStages.tailscaleError'),
      state: 'failed',
      detail: status.error,
    });
  }

  return stages;
}

/**
 * 이 연결이 거치는 단계 전체.
 *
 * Tailscale 을 쓰지 않는 호스트는 그 계층이 아예 없다 — 없는 관문을 보여주면 무엇을 기다리는지
 * 오히려 헷갈린다.
 */
export function resolveConnectionStages(input: {
  tab: TerminalTab | undefined;
  tailnetStatus?: TailnetStatus;
  hasTailscale: boolean;
  /** 대상 기기 주소. 넷맵에서 그 기기를 찾아 경로를 보여주는 데 쓴다. */
  targetAddress?: string;
  failureLayer: ConnectionFailureLayer;
  failureMessage?: string;
  hostKeyPrompted?: boolean;
}): ConnectionStage[] {
  const { tab, tailnetStatus, hasTailscale, failureLayer, failureMessage } = input;
  const stages: ConnectionStage[] = hasTailscale
    ? resolveTailscaleStages(tailnetStatus, failureLayer === 'tailscale', input.targetAddress)
    : [];

  const stage = tab?.connectionProgress?.stage;
  const failed = tab?.status === 'error';
  const connected = tab?.status === 'connected';
  // Tailscale 을 쓰는 호스트는 그 계층이 확실히 연결돼야 호스트 키를 확인할 수 있다. 판정은
  // 코어가 한 곳에서 하고(ready), 여기서 state·expired 로 다시 조합하지 않는다.
  const tailscaleReady = !hasTailscale || tailnetStatus?.ready === true;

  // SSH 가 실패했다는 것은 그 앞의 키 확인은 통과했다는 뜻이다. 아직 안 한 것처럼 두면 사용자는
  // 키 문제를 의심하러 간다.
  const hostKeyDone =
    connected ||
    failureLayer === 'ssh' ||
    stage === 'connecting' ||
    stage === 'waiting-shell' ||
    stage === 'waiting-interactive-auth';
  stages.push({
    id: 'host-key',
    group: 'host',
    label: t('connectStages.hostKey'),
    state:
      failureLayer === 'hostKey'
        ? 'failed'
        : input.hostKeyPrompted
          ? 'blocked'
          : hostKeyDone
            ? 'done'
            : !tailscaleReady
              ? 'pending'
              : stage === 'host-key-check' || stage === 'awaiting-host-trust'
                ? 'active'
                : failed
                  ? 'pending'
                  : 'active',
    detail:
      failureLayer === 'hostKey'
        ? failureMessage
        : input.hostKeyPrompted
          ? t('connectStages.hostKeyPromptDetail')
          : undefined,
  });

  stages.push({
    id: 'ssh',
    group: 'host',
    label: t('connectStages.ssh'),
    state:
      failureLayer === 'ssh'
        ? 'failed'
        : connected
          ? 'done'
          : failed
            ? 'pending'
            : hostKeyDone
              ? 'active'
              : 'pending',
    detail: failureLayer === 'ssh' ? failureMessage : undefined,
  });

  // 분류되지 않은 실패는 진행 중이던 단계에 붙인다.
  //
  // 그러지 않으면 실패한 단계가 "아직 시작 안 함" 으로 남아서 화면에서 사라진다 — 새로운 에러
  // 문구가 나올 때마다 같은 일이 생기므로, 문구를 하나씩 분류하는 것으로는 막을 수 없다.
  if (failed && !stages.some((stage) => stage.state === 'failed')) {
    const current = stages.find(
      (stage) => stage.state === 'active' || stage.state === 'pending',
    );
    if (current) {
      current.state = 'failed';
      current.detail = failureMessage ?? current.detail;
    }
  }

  return stages;
}

/**
 * 대상 기기까지의 경로.
 *
 * 주소는 MagicDNS 짧은 이름·FQDN·tailnet IP 중 무엇이든 올 수 있어서 셋 다 본다. 넷맵을 아직
 * 못 받았으면(기기 목록이 비었으면) 판정하지 않는다 — 그건 앞 단계가 말하고 있다.
 */
function resolveTargetStage(target: string, status: TailnetStatus | undefined): ConnectionStage {
  const stage: ConnectionStage = {
    id: 'tailscale-target',
    group: 'tailscale',
    label: t('connectStages.tailscaleTarget', { target }),
    state: 'pending',
  };

  const peers = status?.peers ?? [];
  if (peers.length === 0) {
    return stage;
  }

  const wanted = target.trim().toLowerCase();
  const peer = peers.find(
    (candidate) =>
      candidate.hostName?.toLowerCase() === wanted ||
      candidate.dnsName?.toLowerCase() === wanted ||
      candidate.dnsName?.toLowerCase().split('.')[0] === wanted ||
      candidate.ips?.some((ip) => ip.toLowerCase() === wanted),
  );

  if (!peer) {
    // 넷맵은 받았는데 대상이 그 안에 없다. 그 기기가 이 네트워크에 없거나 꺼져 있다.
    return { ...stage, state: 'failed', detail: t('connectStages.tailscaleTargetMissing') };
  }

  // 경로가 없으면 그 사실만 말한다. 원인은 여러 개라 단정할 수 없다 — 상대가 꺼져 있을 수도,
  // 홀펀칭이 안 될 수도, 릴레이에 못 닿을 수도 있다. 대신 주고받은 양을 그대로 붙여서 사용자가
  // "보내는데 답이 없다" 를 스스로 읽을 수 있게 한다.
  const traffic = formatTraffic(peer.txBytes, peer.rxBytes);
  if (peer.direct) {
    return { ...stage, state: 'done', detail: joinDetail(t('connectStages.tailscaleTargetDirect'), traffic) };
  }
  if (peer.relay) {
    return {
      ...stage,
      state: 'done',
      detail: joinDetail(t('connectStages.tailscaleTargetRelay', { relay: peer.relay }), traffic),
    };
  }
  return {
    ...stage,
    state: 'failed',
    detail: joinDetail(t('connectStages.tailscaleTargetNoPath'), traffic),
  };
}

function joinDetail(...parts: Array<string | undefined>): string {
  return parts.filter((part) => Boolean(part)).join(' · ');
}

/**
 * 주고받은 양. 둘 다 모르면 아무 말도 하지 않는다.
 *
 * 보낸 것은 있는데 받은 것이 0 인 상태가 이 화면에서 가장 중요한 관찰값이다 — 우리 쪽은 보내고
 * 있고 상대가 답하지 않는다는 뜻이다. 그것을 해석해 주지는 않는다.
 */
function formatTraffic(txBytes?: number, rxBytes?: number): string | undefined {
  if (txBytes === undefined && rxBytes === undefined) {
    return undefined;
  }
  return t('connectStages.tailscaleTargetTraffic', {
    tx: formatBytes(txBytes ?? 0),
    rx: formatBytes(rxBytes ?? 0),
  });
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** 만료 시각을 초 단위까지 붙은 원문 대신 읽을 수 있는 형태로. */
function formatExpiry(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString();
}
