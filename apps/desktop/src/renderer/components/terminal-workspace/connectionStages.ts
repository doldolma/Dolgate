import { isAwsEc2WindowsPlatform } from '@shared';
import type {
  HostRecord,
  TailnetStatus,
  TerminalConnectionStage,
  TerminalTab,
} from '@shared';
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
 * 호스트 계층이 실제로 무엇을 하는지.
 *
 * 이 구분이 없으면 무엇에 붙든 "호스트 키 확인 → SSH 연결" 이 뜬다. 로컬 셸에는 호스트 키도 SSH
 * 도 없고, RDP·시리얼·ECS Exec 은 SSH 를 쓰지 않는다 — 없는 관문을 통과하는 것처럼 보이면 어디서
 * 막혔는지 읽을 수 없다.
 */
export type ConnectionTransport =
  | 'local'
  | 'ssh'
  | 'ssm'
  | 'serial'
  | 'ecs-exec'
  | 'rdp'
  | 'vnc';

/**
 * 연결 하나의 진행 상태. **이 화면이 탭에 대해 아는 것의 전부다.**
 *
 * 예전에는 여기에 TerminalTab 이 그대로 들어와서, 같은 단계 화면을 터미널 밖(포워딩·컨테이너·
 * 공개키 설치)에서 쓸 수 없었다 — 그 경로들에는 탭이 없다. 필요한 네 가지만 받으면 무엇이든
 * 환산해 넣을 수 있다.
 */
export interface ConnectionStageSubject {
  /** 'connected' | 'error' | 그 밖(진행 중). */
  status?: string | null;
  /** 코어가 보고한 세부 단계(connecting·waiting-shell·waiting-interactive-auth …). */
  stage?: string | null;
  /** 터미널 판의 종류(rdp·vnc). 터미널 밖에서는 비어 있다. */
  paneKind?: string | null;
  /** 'local' 이면 원격 관문이 통째로 없다. */
  source?: string | null;
}

/** 터미널 탭을 위 형태로 옮긴다. 탭이 없으면 undefined 그대로 흘린다. */
export function stageSubjectFromTab(
  tab: TerminalTab | undefined,
): ConnectionStageSubject | undefined {
  if (!tab) {
    return undefined;
  }
  return {
    status: tab.status,
    stage: tab.connectionProgress?.stage,
    paneKind: tab.paneKind,
    source: tab.source,
  };
}

/**
 * 진행 상태와 호스트 종류로 전송 방식을 정한다.
 *
 * 호스트 종류를 모르는 동안(목록 로딩 등)은 SSH 로 본다 — 이 앱의 기본이고, 로컬로 잘못 보면
 * 단계가 통째로 사라진다.
 */
export function resolveConnectionTransport(
  subject: ConnectionStageSubject | undefined,
  hostKind: HostRecord['kind'] | undefined,
  awsPlatform?: string | null,
): ConnectionTransport {
  if (subject?.paneKind === 'rdp' || hostKind === 'rdp') {
    return 'rdp';
  }
  if (subject?.paneKind === 'vnc' || hostKind === 'vnc') {
    return 'vnc';
  }
  if (subject?.source === 'local') {
    return 'local';
  }
  switch (hostKind) {
    case 'serial':
      return 'serial';
    case 'aws-ecs':
      return 'ecs-exec';
    case 'aws-ec2':
      // Windows 인스턴스는 SSM 셸(PowerShell)로 붙는다 — SSH 도, 대조할 호스트 키도 없다.
      // 리눅스는 SSH-over-SSM 을 먼저 타므로 그대로 SSH 관문을 보여준다.
      return isAwsEc2WindowsPlatform(awsPlatform) ? 'ssm' : 'ssh';
    default:
      return 'ssh';
  }
}

/** 호스트에 실제로 붙는 마지막 단계의 라벨. 없는 종류(로컬)는 null. */
function transportStageLabel(transport: ConnectionTransport): string | null {
  switch (transport) {
    case 'local':
      return null;
    case 'serial':
      return t('connectStages.serial');
    case 'ecs-exec':
      return t('connectStages.ecsExec');
    case 'rdp':
      return t('connectStages.rdp');
    case 'vnc':
      return t('connectStages.vnc');
    case 'ssm':
      return t('connectStages.ssm');
    default:
      return t('connectStages.ssh');
  }
}

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
  // 등록·로그인이 끝났는지. 코어의 판정을 그대로 쓴다.
  //
  // ready(= 확실히 연결됨)를 쓰면 안 된다. 그 값에는 "지금 컨트롤 플레인과 동기화되는지" 가 섞여
  // 있어서, 동기화만 끊기면 이미 끝난 등록·로그인이 두 줄 모두 미완료로 되돌아간다 — 그 아래
  // 단계에는 체크가 떠 있으니 화면이 거꾸로 진행하는 것처럼 보인다. 두 질문을 코어가 나눠 답한다.
  const authorized = status?.authorized === true;
  const identityInvalid = status?.identityInvalid === true;
  // 동기화가 끊긴 채로 코어가 진행하기로 했는지. 기다리는 중과 넘어간 뒤를 구분하는 값이다.
  const degraded = status?.degraded === true;
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

  // 로그인이 거부됐는지. 이 신호가 있으면 기다려서 풀리는 상태가 아니다 — 설정을 고쳐야 한다.
  const loginError = status?.loginError?.trim();

  // 2) 등록이 아직 유효한지. 만료는 상태로 드러나지 않을 때가 많아서, 드러났으면 그대로 말한다.
  const registrationStage: ConnectionStage = {
    id: 'tailscale-registration',
    group: 'tailscale',
    label: t('connectStages.tailscaleRegistration'),
    state:
      loginError || expired
        ? 'failed'
        : identityInvalid
          ? 'active'
          : authorized
            ? 'done'
            : started
              ? 'active'
              : 'pending',
    detail: loginError
      ? // 백엔드가 준 이유를 그대로 붙인다. "실패했습니다" 만으로는 키를 고쳐야 하는지 알 수 없다.
        joinDetail(t('connectStages.tailscaleLoginRejectedDetail'), loginError)
      : expired
        ? t('connectStages.tailscaleExpiredDetail')
        : identityInvalid
          ? t('connectStages.tailscaleIdentityInvalidDetail')
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
      // 로그인이 거부됐으면 이 단계는 시작조차 못 한 것이다. 실패는 위(등록)에 붙어 있고,
      // 여기서 "진행 중" 으로 그리면 기다리면 될 것처럼 보인다.
      loginError
        ? 'pending'
        : state === 'needsAuth' || state === 'needsApproval'
          ? status?.authUrl || state === 'needsApproval'
            ? 'blocked'
            : 'active'
          : authorized
            ? 'done'
            : 'pending',
    detail: loginError
      ? undefined
      : state === 'needsApproval'
        ? t('connectStages.tailscaleApprovalDetail')
        : state === 'needsAuth'
          ? status?.authUrl
            ? t('connectStages.tailscaleBrowserDetail')
            : // 링크가 오지 않으면 코어가 노드를 다시 세워 등록을 처음부터 밟는다. 그 사실을
              // 여기서 말해야 한다 — 재시작 전후의 상태가 완전히 같아서, 말하지 않으면 화면은
              // 아무 일도 없는 것처럼 보이고 사용자는 멈춘 줄 안다.
              joinDetail(
                t('connectStages.tailscaleLinkDetail'),
                status?.restarts
                  ? t('connectStages.tailscaleRestartDetail', {
                      count: status.restarts,
                    })
                  : undefined,
              )
          : undefined,
  };

  // 4) 컨트롤 플레인과 동기화되고 있는지.
  //
  //    이것이 지금까지 화면에 없어서 "연결됨인데 통신이 안 되는" 상태를 아무도 설명할 수 없었다.
  //    등록이 만료되면 컨트롤 플레인이 이 세션을 끊는데, 노드는 연결됨으로 남고 기기 목록까지
  //    낡은 값으로 유지된다. 기기 수는 그 자체로 신뢰할 수 없으므로 참고값으로만 붙인다.
  //
  //    끊겼다고 실패로 그리지 않는다. 데이터 플레인은 이미 받아 둔 넷맵으로 계속 통하고, 끊긴 것은
  //    갱신 통로다 — 코어가 잠깐 기다린 뒤 진행하기로 했으면(degraded) 그 사실을 경고로 남긴다.
  //    "진행 중"(…)으로 두면 넘어간 뒤에도 무언가를 기다리는 것처럼 보인다.
  const networkStage: ConnectionStage = {
    id: 'tailscale-network',
    group: 'tailscale',
    label: t('connectStages.tailscaleSync'),
    state:
      status?.online === true
        ? 'done'
        : degraded
          ? 'warn'
          : started
            ? 'active'
            : 'pending',
    detail:
      status?.online === true && peers > 0
        ? t('connectStages.tailscalePeersDetail', { count: peers })
        : degraded
          ? t('connectStages.tailscaleDegradedDetail')
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
  /** 이 연결의 진행 상태. 터미널은 stageSubjectFromTab 으로 만들고, 나머지는 직접 채운다. */
  subject: ConnectionStageSubject | undefined;
  tailnetStatus?: TailnetStatus;
  hasTailscale: boolean;
  /** 대상 기기 주소. 넷맵에서 그 기기를 찾아 경로를 보여주는 데 쓴다. */
  targetAddress?: string;
  /** 이 탭이 붙는 호스트의 종류. 없으면(로컬 셸·목록 로딩 중) 탭만 보고 정한다. */
  hostKind?: HostRecord['kind'];
  /** aws-ec2 의 플랫폼. Windows 면 SSH 가 아니라 SSM 셸로 붙어서 관문이 달라진다. */
  awsPlatform?: string | null;
  failureLayer: ConnectionFailureLayer;
  failureMessage?: string;
  hostKeyPrompted?: boolean;
  /**
   * 경유하는 SSH 호스트의 이름. 있으면 터널 관문 두 개가 선다.
   *
   * 호스트 종류로 유추하지 않는다 — 같은 VNC 호스트가 직접 붙기도 하고 터널로 붙기도 하며, 그
   * 판단은 접속 경로가 한다(`ipc/vnc.ts` 의 `openForward`).
   */
  tunnelLabel?: string | null;
}): ConnectionStage[] {
  const { subject, tailnetStatus, hasTailscale, failureLayer, failureMessage } = input;
  const transport = resolveConnectionTransport(subject, input.hostKind, input.awsPlatform);
  const stages: ConnectionStage[] = hasTailscale
    ? resolveTailscaleStages(tailnetStatus, failureLayer === 'tailscale', input.targetAddress)
    : [];

  const stage = (subject?.stage ?? undefined) as TerminalConnectionStage | undefined;
  const failed = subject?.status === 'error';
  const connected = subject?.status === 'connected';
  // Tailscale 을 쓰는 호스트는 그 계층을 통과해야 호스트 키를 확인할 수 있다. 판정은 코어가 한
  // 곳에서 하고(ready·degraded), 여기서 state·expired·online 으로 다시 조합하지 않는다.
  //
  // degraded 를 함께 보는 이유: 코어가 동기화 없이 진행하기로 했으면 다음 관문은 실제로 진행 중이다.
  // 그것을 "아직" 으로 그리면 코어가 넘긴 연결을 화면이 되돌려 세워 둔 것처럼 보인다.
  const tailscaleReady =
    !hasTailscale || tailnetStatus?.ready === true || tailnetStatus?.degraded === true;

  // SSH 가 실패했다는 것은 그 앞의 키 확인은 통과했다는 뜻이다. 아직 안 한 것처럼 두면 사용자는
  // 키 문제를 의심하러 간다.
  const hostKeyDone =
    connected ||
    failureLayer === 'ssh' ||
    stage === 'connecting' ||
    stage === 'waiting-shell' ||
    stage === 'waiting-interactive-auth';
  // 호스트 키는 SSH 를 타는 종류만 확인한다. RDP 는 서버 인증서를 쓰지만 그 확인은 이 오버레이가
  // 아니라 전용 화면에서 받으므로, 여기서 관문으로 세우면 상태를 알 수 없는 줄이 하나 늘어난다.
  const checksHostKey = transport === 'ssh';
  if (checksHostKey) {
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
  }

  // SSH 터널을 거치는 종류(VNC)는 통로가 열려야 원격 프로토콜을 시작할 수 있다.
  //
  // 관문을 둘로 나누는 이유는 이 둘의 실패가 사용자에게 완전히 다르기 때문이다 — 경유 서버에
  // 못 붙은 것이면 그쪽 자격증명 문제이고, 통로는 열렸는데 그 뒤가 막힌 것이면 원격에 VNC 가
  // 안 떠 있다는 뜻이다. 상태는 메인이 보내는 진행 단계로만 채운다(추측하지 않는다).
  const tunnelStages = input.tunnelLabel
    ? resolveTunnelStages(input.tunnelLabel, stage, tailscaleReady, connected, failed)
    : [];
  stages.push(...tunnelStages);
  const tunnelOpen =
    !input.tunnelLabel ||
    connected ||
    stage === 'connecting' ||
    stage === 'ssh-tunnel-open';

  // 앞에 관문이 없는 종류는 tailnet 만 지나면 바로 붙는 중이다.
  const readyToConnect =
    (checksHostKey ? hostKeyDone : tailscaleReady) && tunnelOpen;
  const transportLabel = transportStageLabel(transport);
  if (transportLabel) {
    stages.push({
      id: transport,
      group: 'host',
      label: transportLabel,
      state:
        failureLayer === 'ssh'
          ? 'failed'
          : connected
            ? 'done'
            : failed
              ? 'pending'
              : readyToConnect
                ? 'active'
                : 'pending',
      detail: failureLayer === 'ssh' ? failureMessage : undefined,
    });
  }

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
 * SSH 터널 관문 둘 — 경유 서버 접속, 그리고 통로 개설.
 *
 * 실패는 진행 중이던 관문에 붙는다(호출자의 마지막 정리가 한다). 여기서는 어디까지 갔는지만
 * 정한다: 메인은 통로를 열기 전에 `ssh-tunnel-gateway`, 열린 뒤에 `ssh-tunnel-open` 을 보낸다.
 */
function resolveTunnelStages(
  label: string,
  stage: TerminalConnectionStage | undefined,
  tailscaleReady: boolean,
  connected: boolean,
  failed: boolean,
): ConnectionStage[] {
  // 통로가 열렸다는 보고를 받았거나, 이미 그 뒤로 넘어갔으면 첫 관문은 끝난 것이다.
  const openReported =
    connected || stage === 'ssh-tunnel-open' || stage === 'connecting';
  const gatewayActive = stage === 'ssh-tunnel-gateway';
  return [
    {
      id: 'ssh-tunnel-gateway',
      group: 'host',
      label: t('connectStages.tunnelGateway', { label }),
      state: openReported
        ? 'done'
        : gatewayActive
          ? 'active'
          : // tailnet 이 아직 안 끝났으면 이 관문은 시작조차 못 한다. 실패로 앉은 화면에서도
            // "진행 중" 으로 그리면 기다리면 될 것처럼 보인다.
            !tailscaleReady || failed
            ? 'pending'
            : 'active',
    },
    {
      id: 'ssh-tunnel',
      group: 'host',
      label: t('connectStages.tunnelOpen'),
      state: openReported ? 'done' : 'pending',
    },
  ];
}

/** IPv4·IPv6 주소처럼 보이는지. 이름(MagicDNS)과 주소는 없을 때의 뜻이 다르다. */
function looksLikeIpAddress(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':');
}

/**
 * 주소가 이 CIDR 안에 있는지.
 *
 * IPv4 만 계산한다. IPv6 서브넷 라우팅은 이 화면의 판정 대상이 아니고, 잘못 계산해서 "경로 있음" 을
 * 거짓으로 말하는 것보다 모른다고 두는 편이 낫다.
 */
function addressWithinRoute(address: string, route: string): boolean {
  const [network, prefixText] = route.split('/');
  const prefix = Number(prefixText);
  if (!looksLikeIpAddress(address) || address.includes(':') || !network || network.includes(':')) {
    return false;
  }
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const toNumber = (value: string): number | null => {
    const parts = value.split('.');
    if (parts.length !== 4) {
      return null;
    }
    let result = 0;
    for (const part of parts) {
      const octet = Number(part);
      if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
        return null;
      }
      result = result * 256 + octet;
    }
    return result;
  };
  const target = toNumber(address);
  const base = toNumber(network);
  if (target === null || base === null) {
    return false;
  }
  // prefix 0 은 전체(0.0.0.0/0)다. 시프트 32 는 정의되지 않으므로 따로 다룬다.
  const mask = prefix === 0 ? 0 : (-1 << (32 - prefix)) >>> 0;
  return (target & mask) === (base & mask);
}

/**
 * 대상 기기까지의 경로.
 *
 * 주소는 MagicDNS 짧은 이름·FQDN·tailnet IP 중 무엇이든 올 수 있어서 셋 다 본다. 넷맵을 아직
 * 못 받았으면(기기 목록이 비었으면) 판정하지 않는다 — 그건 앞 단계가 말하고 있다.
 *
 * 기기 목록에 없을 때는 서브넷 라우터가 광고한 대역도 본다. 사내 랜 주소는 기기가 아니라 그 대역을
 * 통해 닿기 때문이다.
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
    // 기기 목록에 없다고 곧바로 실패는 아니다.
    //
    // tailnet 안의 주소는 기기 자신의 것만이 아니다. 서브넷 라우터가 광고한 대역(예: 사내
    // 192.168.x.x)도 이 네트워크를 통해 닿는다. 그 대역을 담당하는 기기가 있으면 경로는 있는 것이다.
    const via = peers.find((candidate) =>
      (candidate.routes ?? []).some((route) => addressWithinRoute(wanted, route)),
    );
    if (via) {
      return {
        ...stage,
        state: 'done',
        detail: t('connectStages.tailscaleTargetViaSubnet', {
          peer: via.hostName || via.dnsName || t('connectStages.tailscaleTargetSubnetRouter'),
        }),
      };
    }
    // 대역도 없고 기기도 아니다. 이름(MagicDNS)으로 지정했다면 그 기기가 이 네트워크에 없다는
    // 뜻이므로 실패다. 하지만 IP 주소라면 tailnet 을 통하지 않는 경로(점프 호스트 뒤의 망, 지금
    // 붙어 있는 랜)로 갈 수 있다 — 그것을 실패로 그리면 멀쩡한 연결을 의심하게 만든다.
    if (looksLikeIpAddress(wanted)) {
      return { ...stage, state: 'warn', detail: t('connectStages.tailscaleTargetNotInTailnet') };
    }
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
