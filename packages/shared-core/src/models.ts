import type { AuthSession } from './api';

export type AuthType =
  | 'password'
  | 'privateKey'
  | 'keyboardInteractive'
  | 'certificate'
  | 'agent';
export type HostKind = 'ssh' | 'aws-ec2' | 'aws-ecs' | 'warpgate-ssh' | 'serial' | 'rdp' | 'vnc';
export type SerialTransport = 'local' | 'raw-tcp' | 'rfc2217';
export type SerialDataBits = 5 | 6 | 7 | 8;
export type SerialParity = 'none' | 'odd' | 'even' | 'mark' | 'space';
export type SerialStopBits = 1 | 1.5 | 2;
export type SerialFlowControl = 'none' | 'xon-xoff' | 'rts-cts' | 'dsr-dtr';
export type SerialLineEnding = 'none' | 'cr' | 'lf' | 'crlf';
export type SerialControlAction = 'break' | 'set-dtr' | 'set-rts';
export type AppTheme = 'system' | 'light' | 'dark';

// UI 언어 선택. 'system' 은 OS 언어를 따르고(한국어면 한국어, 그 외 영어),
// 'ko'/'en' 은 사용자가 명시적으로 고른 언어다.
export type AppLanguage = 'system' | 'ko' | 'en';
export type TerminalThemeId =
  | 'dolssh-dark'
  | 'dolssh-light'
  | 'kanagawa-wave'
  | 'kanagawa-dragon'
  | 'kanagawa-lotus'
  | 'everforest-dark'
  | 'everforest-light'
  | 'night-owl'
  | 'light-owl'
  | 'rose-pine'
  | 'hacker-green'
  | 'hacker-blue'
  | 'hacker-red';
export type GlobalTerminalThemeId = TerminalThemeId | 'system';
export type TerminalFontFamilyId =
  | 'sf-mono'
  | 'menlo'
  | 'monaco'
  | 'consolas'
  | 'cascadia-mono'
  | 'jetbrains-mono'
  | 'fira-code'
  | 'ibm-plex-mono'
  | 'source-code-pro'
  | 'cascadia-code'
  | 'geist-mono'
  | 'roboto-mono'
  | 'ubuntu-mono'
  | 'space-mono'
  | 'inconsolata'
  | 'victor-mono';
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'upToDate' | 'error';
export type SftpPaneId = 'left' | 'right';
export type SftpEndpointKind = 'local' | 'remote';
export type FileEntryKind = 'folder' | 'file' | 'symlink' | 'unknown';
export type HostContainerRuntime = 'docker' | 'podman';
export type HostContainerAction = 'start' | 'stop' | 'restart' | 'remove';
export type SftpBrowserColumnKey = 'name' | 'dateModified' | 'size' | 'kind';
export type ConflictResolution = 'overwrite' | 'skip' | 'keepBoth';
export type SftpConflictPolicy = 'ask' | ConflictResolution;
export type PortForwardMode = 'local' | 'remote' | 'dynamic';
export type PortForwardTransport = 'ssh' | 'aws-ssm' | 'ecs-task' | 'container';
export type AwsSsmPortForwardTargetKind = 'instance-port' | 'remote-host';
export type PortForwardStatus = 'stopped' | 'starting' | 'running' | 'error';
export type DnsOverrideStatus = 'inactive' | 'active';
export type KnownHostTrustStatus = 'trusted' | 'untrusted' | 'mismatch';
export type ActivityLogLevel = 'info' | 'warn' | 'error';
export type ActivityLogCategory = 'session' | 'audit';
export type ActivityLogKind =
  | 'generic'
  | 'session-lifecycle'
  | 'port-forward-lifecycle'
  | 'sftp-lifecycle'
  | 'container-lifecycle'
  | 'container-action';
export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticating' | 'authenticated' | 'offline-authenticated' | 'error';
export type SyncBootstrapStatus = 'idle' | 'syncing' | 'ready' | 'paused' | 'error';
export type AwsProfilesServerSupport = 'unknown' | 'supported' | 'unsupported';
export type TermiusProbeStatus = 'ready' | 'unsupported' | 'not-installed' | 'no-data' | 'error';
export type AwsSshMetadataStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SessionConnectionKind = 'local' | 'ssh' | 'mosh' | 'aws-ssm' | 'warpgate' | 'aws-ecs-exec' | 'serial' | 'rdp' | 'vnc';
export type SessionLifecycleStatus = 'connected' | 'closed' | 'error';
export type PortForwardLifecycleStatus = 'running' | 'closed' | 'error';
export type SftpLifecycleStatus = 'connecting' | 'connected' | 'closed' | 'error';
export type ContainerLifecycleStatus =
  | 'connecting'
  | 'connected'
  | 'unsupported'
  | 'closed'
  | 'error';
export type ContainerWorkspaceKind = 'host-runtime' | 'ecs-cluster';
export type ContainerLifecycleTransport = 'ssh' | 'aws-ssm' | 'warpgate' | 'aws-ecs';
export type ContainerActionStatus = 'success' | 'error';
export type SftpConnectionStage =
  | 'loading-instance-metadata'
  | 'checking-profile'
  | 'browser-login'
  | 'checking-ssm'
  | 'probing-host-key'
  | 'generating-key'
  | 'sending-public-key'
  | 'opening-tunnel'
  | 'connecting-sftp'
  /**
   * 이 호스트가 경유할 tailnet 노드를 올리는 중. 연결을 만들기 전 단계다.
   *
   * 터미널·SFTP·컨테이너가 같은 단계를 쓴다 — 노드는 tailnet 단위로 공유되고, 어느 쪽에서
   * 시작한 연결이든 같은 것을 기다린다.
   */
  | 'tailnet-connecting';
export type AwsSftpDiagnosticReasonCode =
  | 'missing-username'
  | 'missing-availability-zone'
  | 'host-key-missing'
  | 'not-managed-instance'
  | 'eic-access-denied'
  | 'eic-invalid-os-user'
  | 'eic-az-mismatch'
  | 'tunnel-open-failed'
  | 'ssh-auth-failed'
  | 'sftp-subsystem-failed'
  | 'unknown';
export type AwsSftpDiagnosticDetails = Record<
  string,
  string | number | boolean | null
>;
export type ConnectionProgressStage =
  | SftpConnectionStage
  | 'connecting-containers'
  | 'loading-ecs-cluster'
  | 'loading-ecs-metrics';

export const AWS_SFTP_DEFAULT_PORT = 22;
export const DEFAULT_SESSION_REPLAY_RETENTION_COUNT = 1000;
// 사용자가 임의 개수를 지정할 수 있도록 인위적인 하한은 두지 않는다(0/음수만 막는 자연 하한 1).
export const MIN_SESSION_REPLAY_RETENTION_COUNT = 1;
export const MAX_SESSION_REPLAY_RETENTION_COUNT = 10000;
export const MAX_HOST_STARTUP_COMMAND_LENGTH = 32 * 1024;

export type HostStartupCommand =
  | { type: 'command'; command: string }
  | { type: 'snippet'; snippetId: string };

export interface HostEnvVar {
  key: string;
  value: string;
}

export const MAX_HOST_ENV_VARS = 100;

// 호스트 환경변수 정규화: 유효한 env 이름만 남기고, 값은 한 줄로 만든다
// (연결 시 `export KEY='VALUE'` 폴백의 줄 분리를 깨지 않도록 개행 제거).
export function normalizeHostEnvVars(
  value: HostEnvVar[] | null | undefined,
): HostEnvVar[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const result: HostEnvVar[] = [];
  for (const entry of value) {
    if (
      !entry ||
      typeof entry.key !== 'string' ||
      typeof entry.value !== 'string'
    ) {
      continue;
    }
    const key = entry.key.trim();
    if (!envNamePattern.test(key)) {
      continue;
    }
    result.push({ key, value: entry.value.replace(/[\r\n]+/g, '') });
    if (result.length >= MAX_HOST_ENV_VARS) {
      break;
    }
  }
  return result;
}

interface HostBaseRecord {
  id: string;
  kind: HostKind;
  label: string;
  groupName?: string | null;
  tags?: string[];
  terminalThemeId?: TerminalThemeId | null;
  favorite?: boolean | null;
  createdAt: string;
  updatedAt: string;
}

interface HostBaseDraft {
  kind: HostKind;
  label: string;
  groupName?: string | null;
  tags?: string[];
  terminalThemeId?: TerminalThemeId | null;
}

export interface SshHostRecord extends HostBaseRecord {
  kind: 'ssh';
  /**
   * 이 호스트에 닿을 때 경유할 tailnet. 없으면 일반 네트워크로 직접 붙는다.
   *
   * 호스트 이름이 유효한 범위를 정하기도 한다 — 신뢰한 호스트 키는 이 tailnet 안에서만
   * 유효하다(다른 tailnet 의 같은 이름은 다른 머신이다).
   */
  tailnetId?: string | null;
  hostname: string;
  port: number;
  username: string;
  authType: AuthType;
  privateKeyPath?: string | null;
  certificatePath?: string | null;
  secretRef?: string | null;
  /** @deprecated 단일 홉 레거시 필드. 다단은 jumpHostIds 사용. 구버전 호환을 위해 유지(=첫 홉). */
  jumpHostId?: string | null;
  /**
   * ProxyJump 체인(다단 베스천). 순서 = 첫 홉(클라이언트에서 직접 연결)…마지막 홉(타깃 바로 앞).
   * `ssh -J J1,J2 target`과 동일. 비었거나 없으면 직접 연결.
   * 구버전 호환: 이 값이 없고 legacy jumpHostId만 있으면 [jumpHostId]로 취급한다.
   */
  jumpHostIds?: string[] | null;
  startupCommand?: HostStartupCommand | null;
  /** mosh(UDP)로 연결한다. jump host와는 상호 배타(UI에서 차단). null/undefined = SSH. */
  useMosh?: boolean | null;
  /** OpenSSH agent forwarding(-A). 신뢰하는 호스트에서만 켠다. */
  agentForwarding?: boolean | null;
  /**
   * 연결 시 셸에 주입할 환경변수. 자격증명(secretRef)이 아니라 호스트 자체 속성이라
   * 호스트마다 독립적이다(시크릿 공유로 번지지 않는다). 시작 명령과 동일하게 호스트 레코드에 저장.
   */
  env?: HostEnvVar[] | null;
}

export interface SshHostDraft extends HostBaseDraft {
  kind: 'ssh';
  /** 경유할 tailnet. 없으면 일반 네트워크로 직접 붙는다. SshHostRecord.tailnetId 와 같다. */
  tailnetId?: string | null;
  hostname: string;
  port: number;
  username: string;
  authType: AuthType;
  privateKeyPath?: string | null;
  certificatePath?: string | null;
  secretRef?: string | null;
  /** @deprecated 단일 홉 레거시 필드. 다단은 jumpHostIds 사용. 구버전 호환을 위해 유지(=첫 홉). */
  jumpHostId?: string | null;
  /** ProxyJump 체인(다단). 순서 = 첫 홉…마지막 홉. [[SshHostRecord]] 참고. */
  jumpHostIds?: string[] | null;
  startupCommand?: HostStartupCommand | null;
  /** mosh(UDP)로 연결한다. jump host와는 상호 배타(UI에서 차단). null/undefined = SSH. */
  useMosh?: boolean | null;
  /** OpenSSH agent forwarding(-A). 신뢰하는 호스트에서만 켠다. */
  agentForwarding?: boolean | null;
  /** 연결 시 셸에 주입할 환경변수(호스트 속성, 자격증명과 분리). [[SshHostRecord]] 참고. */
  env?: HostEnvVar[] | null;
}

/**
 * 이 호스트에 빌려줄 로컬 모니터 하나.
 *
 * id 만으로는 부족하다 — 재부팅하거나 케이블을 다시 꽂으면 OS 가 주는 디스플레이 id 가 바뀐다
 * (mstsc 가 selectedmonitors 를 .rdp 파일에서만 다루고, 그마저 재부팅 뒤 깨지는 이유가 이것).
 * 그래서 이름과 크기를 함께 남겨 id 가 어긋났을 때 그걸로 다시 맞춘다.
 */
export interface RdpMonitorSelection {
  /** Electron Display.id. 1순위 대조 키. */
  id: number;
  /** 디스플레이 이름. id 가 바뀌었을 때 크기와 함께 2순위로 쓴다. */
  label: string;
  width: number;
  height: number;
}

/**
 * 원격 세션에 노출할 로컬 폴더 하나.
 *
 * 원격에 보이는 드라이브 이름은 저장하지 않는다 — 경로에서 만들어 쓰고, 그 규칙은
 * `describeRdpDrives` 한 곳에만 둔다(편집 화면이 보여주는 이름과 원격에 뜨는 이름이 갈리면
 * 사용자가 어느 폴더인지 알 수 없다).
 */
export interface RdpDriveShare {
  /** 로컬 절대 경로. */
  path: string;
  /** 원격이 이 폴더를 수정하지 못하게 한다. */
  readOnly?: boolean | null;
}

export interface RdpHostRecord extends HostBaseRecord {
  kind: 'rdp';
  hostname: string;
  port: number;
  /**
   * **`username` 을 싣지 않는다.** RDP 계정은 자격증명에 딸려 있어서 쓸 곳이 없고, 넣으면 옛
   * 빌드가 이 레코드를 SSH 로 바꿔 버린다.
   *
   * 왜 이 주석이 여기 있는가: RDP 를 모르는 빌드(1.8.10)는 이 레코드를 받으면
   * `username.trim()` 에서 던져 창이 빈 화면이 된다. 빈 문자열을 채워 두면 그 크래시는 멈추는데,
   * 그 빌드의 `normalizeHostRecord` 가 "hostname·port·username 이 다 있으면 SSH" 로 보고
   * `kind:"ssh"` 로 바꾼 뒤(RDP 필드는 전부 버리고) 전체 스냅샷을 그대로 push 한다. 서버는 같은
   * `updatedAt` + 다른 내용을 마지막 쓰기 승리로 받으므로, **모든 기기에서 RDP 호스트가 SSH 로
   * 덮어써진다.** 빈 화면보다 나쁘다 — 필드가 없으면 그 빌드는 레코드를 그냥 버리고(push 는
   * upsert 라 서버 사본은 남는다) 업데이트하면 그대로 돌아온다.
   *
   * 새 호스트 종류를 추가할 때도 같다: 옛 스키마의 필수 필드를 흉내 내 채우지 말 것. 옛 빌드가
   * "아는 종류" 로 오인해 레코드를 고쳐 쓴다.
   */
  /**
   * 비밀번호는 레코드가 아니라 시크릿 저장소에 둔다. SSH와 같은 규칙이다 —
   * 호스트 레코드는 동기화·내보내기 대상이라 자격증명이 실리면 안 된다.
   */
  secretRef?: string | null;
  /**
   * 신뢰한 서버 인증서의 SHA-256 지문(TOFU 핀).
   *
   * RDP 서버는 대개 자체 서명이라 CA 검증이 성립하지 않는다. 대신 처음 접속할 때 지문을
   * 기록해 두고, 이후 달라지면 사용자에게 묻는다 — SSH known_hosts 와 같은 모델이고
   * mstsc(CertHash)·FreeRDP(known_hosts2)도 같은 방식이다.
   */
  certificateFingerprint?: string | null;
  /**
   * 원격 세션에 노출할 로컬 폴더들. 비어 있거나 없으면 드라이브를 붙이지 않는다.
   *
   * 공유하면 그 폴더 안의 파일이 원격 머신에 그대로 노출된다 — 신뢰하는 호스트에만 켤 것.
   */
  drives?: RdpDriveShare[] | null;
  /**
   * @deprecated `drives` 로 옮겼다. 저장된 값은 읽을 때 `drives` 한 항목으로 바뀐다.
   *
   * 타입에서 지우지 않는 이유: 다른 기기의 옛 빌드가 계속 이 필드를 쓰므로, 지우면 동기화될
   * 때마다 값이 왕복한다.
   */
  drivePath?: string | null;
  /** @deprecated `drives[].readOnly` 로 옮겼다. */
  driveReadOnly?: boolean | null;
  /**
   * 관리 세션으로 붙는다(mstsc 의 `/admin`, Windows App 의 "관리 세션에 연결" 체크박스).
   *
   * 관리 세션은 RDS 클라이언트 라이선스(CAL)를 소모하지 않고, 세션 수 제한에 걸렸거나 호스트가
   * 드레인 중일 때도 붙는다. 옛 `/console` 의 후신이다.
   *
   * 자격증명을 원격에 보내지 않는 `/restrictedAdmin` 과는 다른 기능이다.
   */
  adminSession?: boolean | null;
  /**
   * @deprecated 읽지도 쓰지도 않는다. 모니터 세부 선택은 기기 로컬 설정으로 옮겼다 —
   * 기기마다 붙어 있는 모니터가 다른데 호스트 레코드는 동기화 대상이라 맞지 않았다.
   * 지금은 `useAllMonitors` 만 호스트에 남고, 세부 선택은 기기별로 저장한다.
   *
   * 타입에서 지우지 않는 이유: 다른 기기의 옛 빌드가 계속 이 필드를 쓰므로, 지우면 동기화될
   * 때마다 값이 왕복한다. 옛 값은 그대로 두고 무시한다.
   */
  monitors?: RdpMonitorSelection[] | null;
  /**
   * 붙어 있는 모니터를 전부 쓴다. 끄거나 없으면 창이 있는 화면 하나만 쓴다.
   *
   * 어느 모니터를 쓸지 골라 좁히는 것은 기기 로컬 설정이다(모니터 구성이 기기마다 다르다).
   * 이 토글은 "여러 화면을 쓸 의도가 있는 호스트인가"만 정하므로 동기화해도 뜻이 유지된다.
   */
  useAllMonitors?: boolean | null;
  /** 원격 소리를 받는다. 없거나 null 이면 켜짐. */
  audioEnabled?: boolean | null;
  /** 원격과 클립보드를 주고받는다. 없거나 null 이면 켜짐. */
  clipboardEnabled?: boolean | null;
  /**
   * 색 깊이(비트). 없거나 null 이면 32.
   *
   * 그래픽 파이프라인(EGFX/H.264)이 붙으면 거의 의미가 없다 — 16 은 레거시 경로에서 대역폭을
   * 줄이는 선택이다.
   */
  colorDepth?: 16 | 32 | null;
  /** 경유할 tailnet. 없으면 일반 네트워크로 직접 붙는다. SshHostRecord.tailnetId 와 같다. */
  tailnetId?: string | null;
  /**
   * AWS SSM 을 거쳐 붙는다. 없으면 `hostname` 으로 직접 붙는다.
   *
   * **새 호스트 종류를 만들지 않은 이유:** SSM 경유는 종류가 아니라 **경로**다. `tailnetId` 와
   * 같은 성격이고, 그때도 별도 kind 를 만들지 않았다. 연결 시 SSM 포트 포워딩으로 로컬 주소를
   * 얻어 그것을 dial 하되, TLS 서버 이름과 인증서 지문 핀은 `hostname` 기준을 유지한다.
   */
  awsSsm?: RdpAwsSsmTarget | null;
}

/**
 * SSM 으로 3389 에 닿기 위해 필요한 최소 정보.
 *
 * 인스턴스의 사설 IP 는 `RdpHostRecord.hostname` 에 그대로 둔다 — SSM 이 안 될 때 같은 네트워크에서
 * 직접 붙는 경로가 살아 있어야 하고, 인증서 핀의 키도 그 이름이다.
 */
export interface RdpAwsSsmTarget {
  /** 로컬 AWS 프로파일 이름. 기기마다 다를 수 있어 이름으로 들고 있는다. */
  profileName: string;
  region: string;
  instanceId: string;
}

/**
 * VNC(RFB) 호스트.
 *
 * **`username` 을 두지 않는다.** RFB 의 기본 인증(VncAuth)은 비밀번호만 쓰고 사용자 이름이라는
 * 개념이 없다. 그리고 옛 빌드가 "hostname·port·username 이 다 있으면 SSH" 로 오인해 레코드를
 * 고쳐 되올리는 문제가 있어(RdpHostRecord 주석 참고) 옛 스키마의 필수 필드를 흉내 내면 안 된다.
 *
 * RDP 와 겹치는 필드(secretRef·tailnetId)는 이름과 뜻을 그대로 맞춘다 — 두 종류를 함께 다루는
 * 화면·정규화 코드가 같은 이름을 기대한다.
 */
/** VNC 화면 압축 화질. [[VncHostRecord.imageQuality]] 참고. */
export type VncImageQuality = 'lossless' | 'balanced' | 'fast';

export interface VncHostRecord extends HostBaseRecord {
  kind: 'vnc';
  hostname: string;
  /** RFB 기본 포트는 5900 이다. 디스플레이 번호 n 은 5900+n 으로 쓰는 관행이다. */
  port: number;
  /**
   * 비밀번호는 레코드가 아니라 시크릿 저장소에 둔다. RDP·SSH 와 같은 규칙이다.
   *
   * **VNC 비밀번호는 8자만 유효하다** — 규격이 DES 키로 쓰기 위해 잘라낸다. 폼에서 그 사실을
   * 알려야 사용자가 9자 이상을 넣고 실패 원인을 찾지 못하는 일이 없다.
   */
  secretRef?: string | null;
  /**
   * 이 세션이 화면을 다른 클라이언트와 공유한다. 없거나 null 이면 공유(true).
   *
   * 끄면 서버가 **기존에 붙어 있던 클라이언트를 끊는다.** 남의 세션을 끊는 것은 사용자가 명시적으로
   * 고를 일이라 기본을 공유로 둔다.
   */
  shared?: boolean | null;
  /**
   * 화면만 보고 입력은 보내지 않는다. 없거나 null 이면 꺼짐.
   *
   * 서버 쪽 view-only 설정과는 별개의, 이 클라이언트에서의 안전장치다 — 운영 중인 콘솔을 실수로
   * 클릭하는 것을 막는 용도다.
   */
  viewOnly?: boolean | null;
  /** 경유할 tailnet. 없으면 일반 네트워크로 직접 붙는다. SshHostRecord.tailnetId 와 같다. */
  tailnetId?: string | null;
  /**
   * 이 SSH 호스트를 거쳐 포트 포워딩으로 닿는다. 없으면 `hostname` 으로 직접 붙는다.
   *
   * **VNC 에서 이 경로가 특히 중요하다.** QEMU·libvirt 콘솔은 5900 을 localhost 에만 바인딩하는
   * 것이 관행이라 그 경로가 아니면 아예 닿지 않는다. tailnetId 와 같은 성격이다 — 종류가 아니라
   * 경로이므로 별도 kind 를 만들지 않는다.
   */
  sshTunnelHostId?: string | null;
  /**
   * 화면 압축 화질. 없거나 null 이면 무손실이다.
   *
   * - `lossless` — JPEG 를 쓰지 않는다. 글자가 선명하다.
   * - `balanced` — 사진 영역을 JPEG 로 보낸다(품질 8). 대역폭이 크게 준다.
   * - `fast` — 가장 아낀다(품질 4). 사진이 눈에 보이게 뭉개진다.
   *
   * **기본을 무손실로 두는 이유**: 서버는 우리가 품질을 선언할 때만 JPEG 를 쓴다(TigerVNC 실측 —
   * 선언이 없으면 JPEG 사각형이 0개, balanced 로는 81개). 터미널·문서를 보는 세션에서 글자가
   * 뭉개지면 안 되므로 켜는 것은 사용자가 고를 일이다.
   */
  imageQuality?: VncImageQuality | null;
}

export interface RdpHostDraft extends HostBaseDraft {
  kind: 'rdp';
  hostname: string;
  port: number;

  secretRef?: string | null;
  /** 원격 세션에 노출할 로컬 폴더들. [[RdpHostRecord]] 참고. */
  drives?: RdpDriveShare[] | null;
  /** @deprecated `drives` 로 옮겼다. [[RdpHostRecord]] 참고. */
  drivePath?: string | null;
  /** @deprecated `drives[].readOnly` 로 옮겼다. */
  driveReadOnly?: boolean | null;
  /** 관리 세션으로 붙는다. [[RdpHostRecord]] 참고. */
  adminSession?: boolean | null;
  /** @deprecated 안 쓴다. [[RdpHostRecord]] 참고. */
  monitors?: RdpMonitorSelection[] | null;
  /** 붙어 있는 모니터를 전부 쓴다. [[RdpHostRecord]] 참고. */
  useAllMonitors?: boolean | null;
  /** 원격 소리를 받는다. 기본 켜짐. [[RdpHostRecord]] 참고. */
  audioEnabled?: boolean | null;
  /** 원격과 클립보드를 주고받는다. 기본 켜짐. [[RdpHostRecord]] 참고. */
  clipboardEnabled?: boolean | null;
  /** 색 깊이(비트). 기본 32. [[RdpHostRecord]] 참고. */
  colorDepth?: 16 | 32 | null;
  /** 경유할 tailnet. [[RdpHostRecord]] 참고. */
  tailnetId?: string | null;
  /** AWS SSM 경유. [[RdpHostRecord]] 참고. */
  awsSsm?: RdpAwsSsmTarget | null;
}

export interface AwsEc2HostRecord extends HostBaseRecord {
  kind: 'aws-ec2';
  awsProfileId?: string | null;
  awsProfileName: string;
  awsRegion: string;
  awsInstanceId: string;
  awsAvailabilityZone?: string | null;
  awsInstanceName?: string | null;
  awsPlatform?: string | null;
  awsPrivateIp?: string | null;
  awsState?: string | null;
  awsSshUsername?: string | null;
  awsSshPort?: number | null;
  awsSshMetadataStatus?: AwsSshMetadataStatus | null;
  awsSshMetadataError?: string | null;
  awsSsmServerProxyEnabled?: boolean;
  /** OpenSSH agent forwarding(-A). 신뢰하는 호스트에서만 켠다. */
  agentForwarding?: boolean | null;
  startupCommand?: HostStartupCommand | null;
}

export interface AwsEc2HostDraft extends HostBaseDraft {
  kind: 'aws-ec2';
  awsProfileId?: string | null;
  awsProfileName: string;
  awsRegion: string;
  awsInstanceId: string;
  awsAvailabilityZone?: string | null;
  awsInstanceName?: string | null;
  awsPlatform?: string | null;
  awsPrivateIp?: string | null;
  awsState?: string | null;
  awsSshUsername?: string | null;
  awsSshPort?: number | null;
  awsSshMetadataStatus?: AwsSshMetadataStatus | null;
  awsSshMetadataError?: string | null;
  awsSsmServerProxyEnabled?: boolean;
  /** OpenSSH agent forwarding(-A). 신뢰하는 호스트에서만 켠다. */
  agentForwarding?: boolean | null;
  startupCommand?: HostStartupCommand | null;
}

export interface AwsEcsHostRecord extends HostBaseRecord {
  kind: 'aws-ecs';
  awsProfileId?: string | null;
  awsProfileName: string;
  awsRegion: string;
  awsEcsClusterArn: string;
  awsEcsClusterName: string;
}

export interface AwsEcsHostDraft extends HostBaseDraft {
  kind: 'aws-ecs';
  awsProfileId?: string | null;
  awsProfileName: string;
  awsRegion: string;
  awsEcsClusterArn: string;
  awsEcsClusterName: string;
}

export interface WarpgateSshHostRecord extends HostBaseRecord {
  kind: 'warpgate-ssh';
  warpgateBaseUrl: string;
  warpgateSshHost: string;
  warpgateSshPort: number;
  warpgateTargetId: string;
  warpgateTargetName: string;
  warpgateUsername: string;
  startupCommand?: HostStartupCommand | null;
}

export interface WarpgateSshHostDraft extends HostBaseDraft {
  kind: 'warpgate-ssh';
  warpgateBaseUrl: string;
  warpgateSshHost: string;
  warpgateSshPort: number;
  warpgateTargetId: string;
  warpgateTargetName: string;
  warpgateUsername: string;
  startupCommand?: HostStartupCommand | null;
}

export interface SerialHostRecord extends HostBaseRecord {
  kind: 'serial';
  transport: SerialTransport;
  devicePath?: string | null;
  host?: string | null;
  port?: number | null;
  baudRate: number;
  dataBits: SerialDataBits;
  parity: SerialParity;
  stopBits: SerialStopBits;
  flowControl: SerialFlowControl;
  transmitLineEnding: SerialLineEnding;
  localEcho: boolean;
  localLineEditing: boolean;
}

export interface SerialHostDraft extends HostBaseDraft {
  kind: 'serial';
  transport: SerialTransport;
  devicePath?: string | null;
  host?: string | null;
  port?: number | null;
  baudRate: number;
  dataBits: SerialDataBits;
  parity: SerialParity;
  stopBits: SerialStopBits;
  flowControl: SerialFlowControl;
  transmitLineEnding: SerialLineEnding;
  localEcho: boolean;
  localLineEditing: boolean;
}

export interface SerialPortSummary {
  path: string;
  displayName: string;
  manufacturer?: string | null;
}

// HostRecord는 로컬 스토리지와 sync payload가 공유하는 정규화된 호스트 모델이다.
export interface VncHostDraft extends HostBaseDraft {
  kind: 'vnc';
  hostname: string;
  port: number;

  secretRef?: string | null;
  /** 화면을 다른 클라이언트와 공유한다. 기본 켜짐. [[VncHostRecord]] 참고. */
  shared?: boolean | null;
  /** 입력을 보내지 않는다. 기본 꺼짐. [[VncHostRecord]] 참고. */
  viewOnly?: boolean | null;
  tailnetId?: string | null;
  /** 이 SSH 호스트를 거쳐 붙는다. [[VncHostRecord]] 참고. */
  sshTunnelHostId?: string | null;
  /** 화면 압축 화질. [[VncHostRecord.imageQuality]] 참고. */
  imageQuality?: VncImageQuality | null;
}

export type HostRecord =
  | SshHostRecord
  | AwsEc2HostRecord
  | AwsEcsHostRecord
  | WarpgateSshHostRecord
  | SerialHostRecord
  | RdpHostRecord
  | VncHostRecord;

// HostDraft는 생성/수정 폼에서 사용하는 입력 전용 모델이다.
export type HostDraft =
  | SshHostDraft
  | AwsEc2HostDraft
  | AwsEcsHostDraft
  | WarpgateSshHostDraft
  | SerialHostDraft
  | RdpHostDraft
  | VncHostDraft;

/**
 * 이 탭을 드래그-분할 화면에 넣을 수 있는가.
 *
 * **원격 화면(RDP·VNC)은 넣지 않는다.** 프레임버퍼 하나를 반쪽 pane 에 넣으면 글자를 읽을 수 없고,
 * 창 크기에 맞춰 원격 해상도를 따라가는 기능(자동 리사이즈)이 분할·복원마다 원격 배치를 다시 잡는다.
 * RDP 는 보조 모니터 창까지 있어 어느 창이 어느 pane 인지도 흐려진다.
 *
 * tmux 그룹 탭은 자체 pane 레이아웃을 갖고 있어 이미 별도 경로로 걸러진다(appShellUtils 참고).
 */
export function isSplittablePaneKind(
  paneKind: 'terminal' | 'rdp' | 'vnc' | undefined | null,
): boolean {
  return paneKind !== 'rdp' && paneKind !== 'vnc';
}

export function isSshHostRecord(host: HostRecord): host is SshHostRecord {
  return host.kind === 'ssh';
}

export function isAwsEc2HostRecord(host: HostRecord): host is AwsEc2HostRecord {
  return host.kind === 'aws-ec2';
}

export function isAwsEcsHostRecord(host: HostRecord): host is AwsEcsHostRecord {
  return host.kind === 'aws-ecs';
}

export function isWarpgateSshHostRecord(host: HostRecord): host is WarpgateSshHostRecord {
  return host.kind === 'warpgate-ssh';
}

export function isSerialHostRecord(host: HostRecord): host is SerialHostRecord {
  return host.kind === 'serial';
}

export function isRdpHostRecord(host: HostRecord): host is RdpHostRecord {
  return host.kind === 'rdp';
}

export function isVncHostRecord(host: HostRecord): host is VncHostRecord {
  return host.kind === 'vnc';
}

export function isVncHostDraft(draft: HostDraft): draft is VncHostDraft {
  return draft.kind === 'vnc';
}

/**
 * 이 빌드가 아는 호스트 종류.
 *
 * `HostKind` 는 타입이라 런타임에 물어볼 수 없다. 동기화로 받은 레코드는 이 빌드보다 새 버전이
 * 만든 것일 수 있어서, 그때 "아는 종류인가" 를 실제로 물어봐야 한다.
 */
const KNOWN_HOST_KINDS: ReadonlySet<string> = new Set<HostKind>([
  'ssh',
  'aws-ec2',
  'aws-ecs',
  'warpgate-ssh',
  'serial',
  'rdp',
  'vnc',
]);

/**
 * 이 빌드가 다룰 수 있는 종류인가.
 *
 * **바깥에서 들어온 호스트는 전부 이걸 통과해야 한다** — 동기화 pull, `.dolgate` 가져오기, 그리고
 * 저장 계층의 정규화(`normalizeHostRecord` 는 종류별 분기로 같은 판정을 한다). 세 곳이 각자
 * 목록을 들고 있으면 어긋나고, 어긋나면 한쪽이 버린 레코드를 다른 쪽이 고쳐 쓴다.
 *
 * 모르는 종류를 그대로 상태에
 * 넣으면, 그 레코드의 없는 필드를 읽는 코드가 렌더 중에 던져 목록을 그리다 화면이 통째로 빈다
 * (1.8.10 이 RDP 호스트를 받고 그렇게 됐다). 호스트 목록은 기기 사이에서 동기화되고 기기마다
 * 버전이 다르므로, "모르는 종류가 온다" 는 예외가 아니라 정상 상황이다.
 *
 * 걸러낸 레코드는 **버리는 것이 아니라 이 기기에서 안 보이게 두는 것**이다 — 서버 push 는
 * upsert 라서 우리가 안 올린 레코드는 그대로 남고, 업데이트하면 다시 보인다. 대신 정규화해서
 * 억지로 끼워 맞추지는 않는다. 그러면 모르는 필드를 잃은 채 되올려 원본을 망친다.
 */
export function isKnownHostKind(kind: unknown): kind is HostKind {
  return typeof kind === 'string' && KNOWN_HOST_KINDS.has(kind);
}

export function isSshHostDraft(host: HostDraft): host is SshHostDraft {
  return host.kind === 'ssh';
}

export function isAwsEc2HostDraft(host: HostDraft): host is AwsEc2HostDraft {
  return host.kind === 'aws-ec2';
}

export function isAwsEcsHostDraft(host: HostDraft): host is AwsEcsHostDraft {
  return host.kind === 'aws-ecs';
}

export function isWarpgateSshHostDraft(host: HostDraft): host is WarpgateSshHostDraft {
  return host.kind === 'warpgate-ssh';
}

export function isSerialHostDraft(host: HostDraft): host is SerialHostDraft {
  return host.kind === 'serial';
}

export function isRdpHostDraft(host: HostDraft): host is RdpHostDraft {
  return host.kind === 'rdp';
}

export function getHostSearchText(host: HostRecord): string[] {
  if (host.kind === 'aws-ec2') {
    return [
      host.label,
      host.awsInstanceName ?? '',
      host.awsInstanceId,
      host.awsRegion,
      host.awsAvailabilityZone ?? '',
      host.awsProfileName,
      host.awsPrivateIp ?? '',
      host.awsSshUsername ?? '',
      host.groupName ?? '',
      ...(host.tags ?? [])
    ];
  }
  if (host.kind === 'warpgate-ssh') {
    return [
      host.label,
      host.warpgateTargetName,
      host.warpgateTargetId,
      host.warpgateUsername,
      host.warpgateBaseUrl,
      host.groupName ?? '',
      ...(host.tags ?? [])
    ];
  }
  if (host.kind === 'aws-ecs') {
    return [
      host.label,
      host.awsEcsClusterName,
      host.awsEcsClusterArn,
      host.awsRegion,
      host.awsProfileName,
      host.groupName ?? '',
      ...(host.tags ?? []),
    ];
  }
  if (host.kind === 'rdp') {
    return [
      host.label,
      host.hostname,
      host.groupName ?? '',
      ...(host.tags ?? []),
    ];
  }
  if (host.kind === 'serial') {
    return [
      host.label,
      host.transport,
      host.devicePath ?? '',
      host.host ?? '',
      typeof host.port === 'number' ? String(host.port) : '',
      host.groupName ?? '',
      ...(host.tags ?? []),
    ];
  }
  if (host.kind === 'vnc') {
    // 계정이 없다(비밀번호만 쓴다). 주소·포트로 찾을 수 있게 한다.
    return [
      host.label,
      host.hostname,
      String(host.port),
      host.groupName ?? '',
      ...(host.tags ?? []),
    ];
  }
  return [host.label, host.hostname, host.username, host.groupName ?? '', ...(host.tags ?? [])];
}

// 조립 결과를 코드로 돌려줄 수는 없으니(호출처마다 조립을 다시 써야 한다) 값이 비었을 때의
// 폴백 라벨만 받는다. 필수 인자로 둬서 한 곳이라도 빠지면 컴파일러가 짚어 준다.
export interface HostSubtitleLabels {
  devicePathUnset: string;
  remoteAddressUnset: string;
  usernameUnset: string;
}

export function getHostSubtitle(host: HostRecord, labels: HostSubtitleLabels): string {
  if (host.kind === 'aws-ec2') {
    const parts = ['AWS', host.awsRegion, host.awsPrivateIp || host.awsInstanceId].filter(Boolean);
    return parts.join(' • ');
  }
  if (host.kind === 'warpgate-ssh') {
    const target = host.warpgateTargetName || host.warpgateTargetId;
    return ['Warpgate', host.warpgateUsername, target].filter(Boolean).join(' • ');
  }
  if (host.kind === 'aws-ecs') {
    return [host.awsProfileName, host.awsRegion, host.awsEcsClusterName]
      .filter(Boolean)
      .join(' • ');
  }
  if (host.kind === 'rdp') {
    // 계정은 자격증명에 있어 레코드에 없다. 여기서는 주소만 보여준다.
    return ['RDP', `${host.hostname}:${host.port}`].join(' • ');
  }
  if (host.kind === 'vnc') {
    // VNC 도 계정이 없다(비밀번호만 쓴다).
    return ['VNC', `${host.hostname}:${host.port}`].join(' • ');
  }
  if (host.kind === 'serial') {
    if (host.transport === 'local') {
      return ['Serial', host.devicePath ?? labels.devicePathUnset].join(' • ');
    }
    return [
      'Serial',
      host.transport,
      host.host && host.port ? `${host.host}:${host.port}` : labels.remoteAddressUnset,
    ]
      .filter(Boolean)
      .join(' • ');
  }
  // 마지막은 SSH 다. 다만 **이 빌드가 모르는 종류도 여기로 떨어진다** — 호스트 목록은 버전
  // 사이에서 동기화되므로, 새 버전에서 만든 종류를 옛 빌드가 받는 일이 실제로 일어난다.
  // 그때 없는 필드를 그냥 읽으면 목록을 그리다 렌더러가 죽어 화면이 통째로 빈다(1.8.10 이
  // RDP 호스트를 받고 `username.trim()` 에서 그렇게 됐다). 한 호스트 때문에 앱이 안 뜨는 것보다
  // 그 줄만 덜 보여주는 편이 낫다.
  const username = typeof host.username === 'string' ? host.username.trim() : '';
  const hostname = typeof host.hostname === 'string' ? host.hostname.trim() : '';
  if (!hostname) {
    return host.label;
  }
  const address = host.port ? `${hostname}:${host.port}` : hostname;
  return username ? `${username}@${address}` : `${address} • ${labels.usernameUnset}`;
}

export function getHostBadgeLabel(host: HostRecord): string {
  if (host.kind === 'aws-ec2') {
    return 'AWS';
  }
  if (host.kind === 'warpgate-ssh') {
    return 'WARP';
  }
  if (host.kind === 'aws-ecs') {
    return 'ECS';
  }
  if (host.kind === 'serial') {
    return 'SER';
  }
  if (host.kind === 'rdp') {
    return 'RDP';
  }
  if (host.kind === 'vnc') {
    return 'VNC';
  }
  if (host.authType === 'privateKey') {
    return 'K';
  }
  if (host.authType === 'certificate') {
    return 'C';
  }
  return 'S';
}

export function getHostSecretRef(host: HostRecord): string | null {
  if (host.kind === 'ssh' || host.kind === 'rdp') {
    return host.secretRef ?? null;
  }
  return null;
}

/**
 * ProxyJump 체인을 정규화한다. 신규 jumpHostIds 우선, 없으면 레거시 단일 jumpHostId를 [id]로 본다.
 * 빈 문자열·중복은 제거하고 순서는 보존한다(첫 홉 = 직접 연결 … 마지막 홉 = 타깃 바로 앞).
 */
export function normalizeJumpHostIds(
  jumpHostIds: readonly (string | null | undefined)[] | null | undefined,
  legacyJumpHostId?: string | null,
): string[] {
  const source =
    Array.isArray(jumpHostIds) && jumpHostIds.length > 0
      ? jumpHostIds
      : legacyJumpHostId
        ? [legacyJumpHostId]
        : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of source) {
    if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function normalizeAwsPlatform(value?: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

export function isAwsEc2WindowsPlatform(value?: string | null): boolean {
  const normalized = normalizeAwsPlatform(value);
  return normalized.includes('windows');
}

// 문구가 아니라 코드를 돌려준다 — 앱마다 자기 카탈로그로 문구를 만든다.
export type AwsEc2SftpDisabledReason = 'windows-unsupported';

export function getAwsEc2SftpDisabledReason(input: {
  awsPlatform?: string | null;
  awsSshUsername?: string | null;
}): AwsEc2SftpDisabledReason | null {
  if (isAwsEc2WindowsPlatform(input.awsPlatform)) {
    return 'windows-unsupported';
  }
  return null;
}


export const AWS_SFTP_DIAGNOSTIC_REASON_CODES: readonly AwsSftpDiagnosticReasonCode[] = [
  'missing-username',
  'missing-availability-zone',
  'host-key-missing',
  'not-managed-instance',
  'eic-access-denied',
  'eic-invalid-os-user',
  'eic-az-mismatch',
  'tunnel-open-failed',
  'ssh-auth-failed',
  'sftp-subsystem-failed',
  'unknown',
];

export function isAwsSftpDiagnosticReasonCode(
  value: unknown,
): value is AwsSftpDiagnosticReasonCode {
  return (
    typeof value === 'string' &&
    AWS_SFTP_DIAGNOSTIC_REASON_CODES.includes(
      value as AwsSftpDiagnosticReasonCode,
    )
  );
}

// 사람이 읽는 진단 문구(title/message/action)는 이 패키지에 두지 않는다 — 모바일이 쓰지
// 않는 UI 문구이고, 앱마다 자기 언어 카탈로그로 만들어야 한다. 여기서는 원인 코드까지만
// 만들고, 문구는 apps/desktop/src/common/aws-diagnostics.ts 가 담당한다.
//
// 아래 정규식의 한국어는 들어오는 오류 메시지를 판정하는 패턴이라 지우면 안 된다(영어
// 대안과 함께 유지).
export function inferAwsSftpDiagnosticReasonCode(
  stage: SftpConnectionStage | null | undefined,
  message: string,
): AwsSftpDiagnosticReasonCode {
  const normalized = message.toLowerCase();
  if (/host key is not trusted|host key.+trusted|호스트 키/.test(normalized)) {
    return 'host-key-missing';
  }
  if (/managed instance|ssm managed|ssm 관리/.test(normalized)) {
    return 'not-managed-instance';
  }
  if (/availability zone|\baz\b/.test(normalized)) {
    return 'missing-availability-zone';
  }
  if (
    /instanceosuser|instance os user|os user|ssh username|사용자명|username/.test(
      normalized,
    )
  ) {
    return stage === 'sending-public-key'
      ? 'eic-invalid-os-user'
      : 'missing-username';
  }
  if (
    /accessdenied|unauthorizedoperation|not authorized|is not authorized|권한|거부/.test(
      normalized,
    )
  ) {
    return stage === 'sending-public-key' ? 'eic-access-denied' : 'unknown';
  }
  if (/availability zone.+match|az.+match|zone.+mismatch/.test(normalized)) {
    return 'eic-az-mismatch';
  }
  if (stage === 'opening-tunnel') {
    return 'tunnel-open-failed';
  }
  if (
    stage === 'connecting-sftp' &&
    /subsystem|sftp server|filexfer|sftp subsystem/.test(normalized)
  ) {
    return 'sftp-subsystem-failed';
  }
  if (
    stage === 'connecting-sftp' &&
    /dial failed: dial tcp (127\.0\.0\.1|localhost|\[?::1\]?):\d+: connect: connection refused/.test(
      normalized,
    )
  ) {
    return 'tunnel-open-failed';
  }
  if (
    stage === 'connecting-sftp' &&
    // "connection was refused" 는 tailnet 경유 dial(gvisor netstack) 문구다.
    /authentication failed|unable to authenticate|permission denied|ssh handshake|unexpected message type 51|connection (was )?refused|timed out/.test(
      normalized,
    )
  ) {
    return 'ssh-auth-failed';
  }
  return 'unknown';
}




export function getAwsEc2HostSshPort(input: {
  awsSshPort?: number | null;
}): number {
  const value = input.awsSshPort;
  if (!Number.isInteger(value) || !value || value < 1 || value > 65535) {
    return AWS_SFTP_DEFAULT_PORT;
  }
  return value;
}

export function buildAwsSsmKnownHostIdentity(input: {
  profileName: string;
  region: string;
  instanceId: string;
}): string {
  return `aws-ssm:${input.profileName}:${input.region}:${input.instanceId}`;
}

// GroupRecord는 홈 화면의 그룹 브라우징이 쓰는 계층형 그룹 메타데이터다.
export interface GroupRecord {
  id: string;
  name: string;
  path: string;
  parentPath?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GroupRemoveMode = 'delete-subtree' | 'reparent-descendants';

export interface GroupRemoveResult {
  groups: GroupRecord[];
  hosts: HostRecord[];
}

export interface GroupPathMutationResult {
  groups: GroupRecord[];
  hosts: HostRecord[];
  nextPath: string;
}

export interface TermiusImportCounts {
  groups: number;
  hosts: number;
  keys: number;
  multiKeys: number;
  sshConfigs: number;
  sshConfigIdentities: number;
  identities: number;
}

export interface TermiusImportWarning {
  code?: string | null;
  message: string;
}

export interface TermiusImportGroupPreview {
  path: string;
  name: string;
  parentPath?: string | null;
  hostCount: number;
}

export interface TermiusImportHostPreview {
  key: string;
  name: string;
  address: string | null;
  groupPath?: string | null;
  port: number | null;
  username: string | null;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  identityName: string | null;
}

export interface TermiusProbeResult {
  status: TermiusProbeStatus;
  snapshotId?: string | null;
  message?: string | null;
  meta?: {
    counts: TermiusImportCounts;
    warnings: TermiusImportWarning[];
    termiusDataDir?: string | null;
    exportedAt?: string | null;
  } | null;
  groups: TermiusImportGroupPreview[];
  hosts: TermiusImportHostPreview[];
}

export interface TermiusImportSelectionInput {
  snapshotId: string;
  selectedGroupPaths: string[];
  selectedHostKeys: string[];
}

export interface TermiusImportResult {
  createdGroupCount: number;
  createdHostCount: number;
  createdSecretCount: number;
  skippedHostCount: number;
  warnings: TermiusImportWarning[];
}

export interface OpenSshImportWarning {
  code?: string | null;
  message: string;
  filePath?: string | null;
  lineNumber?: number | null;
}

export interface OpenSshHostPreview {
  key: string;
  alias: string;
  hostname: string;
  port: number;
  username: string;
  authType: 'password' | 'privateKey';
  identityFilePath?: string | null;
  sourceFilePath: string;
  sourceLine: number;
}

export type OpenSshSourceOrigin = 'default-ssh-dir' | 'manual-file';

export interface OpenSshSourceSummary {
  id: string;
  filePath: string;
  origin: OpenSshSourceOrigin;
  label: string;
}

export interface OpenSshProbeResult {
  snapshotId: string;
  sources: OpenSshSourceSummary[];
  hosts: OpenSshHostPreview[];
  warnings: OpenSshImportWarning[];
  skippedExistingHostCount: number;
  skippedDuplicateHostCount: number;
}

export interface OpenSshSnapshotFileInput {
  snapshotId: string;
  filePath: string;
}

export interface OpenSshImportSelectionInput {
  snapshotId: string;
  selectedHostKeys: string[];
  groupPath?: string | null;
}

export interface OpenSshImportResult {
  createdHostCount: number;
  createdSecretCount: number;
  skippedHostCount: number;
  warnings: OpenSshImportWarning[];
}

export interface XshellImportWarning {
  code?: string | null;
  message: string;
  filePath?: string | null;
}

export type XshellSourceOrigin = 'default-session-dir' | 'manual-folder';

export interface XshellSourceSummary {
  id: string;
  folderPath: string;
  origin: XshellSourceOrigin;
  label: string;
}

export interface XshellImportGroupPreview {
  path: string;
  name: string;
  parentPath?: string | null;
  hostCount: number;
}

export interface XshellImportHostPreview {
  key: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  authType: 'password' | 'privateKey';
  groupPath?: string | null;
  privateKeyPath?: string | null;
  sourceFilePath: string;
  hasPasswordHint: boolean;
  hasAuthProfile: boolean;
}

export interface XshellProbeResult {
  snapshotId: string;
  sources: XshellSourceSummary[];
  groups: XshellImportGroupPreview[];
  hosts: XshellImportHostPreview[];
  warnings: XshellImportWarning[];
  skippedExistingHostCount: number;
  skippedDuplicateHostCount: number;
}

export interface XshellSnapshotFolderInput {
  snapshotId: string;
  folderPath: string;
}

export interface XshellImportSelectionInput {
  snapshotId: string;
  selectedGroupPaths: string[];
  selectedHostKeys: string[];
}

export interface XshellImportResult {
  createdGroupCount: number;
  createdHostCount: number;
  createdSecretCount: number;
  skippedHostCount: number;
  warnings: XshellImportWarning[];
}

export interface TerminalAppearanceSettings {
  globalTerminalThemeId: GlobalTerminalThemeId;
  terminalFontFamily: TerminalFontFamilyId;
  terminalFontSize: number;
  terminalScrollbackLines: number;
  terminalLineHeight: number;
  terminalLetterSpacing: number;
  terminalMinimumContrastRatio: number;
  terminalAltIsMeta: boolean;
  terminalWebglEnabled: boolean;
  terminalAutocompleteEnabled: boolean;
}

// AppSettings는 사용자의 로컬 환경 설정을 표현한다.
export interface SftpBrowserColumnWidths {
  name: number;
  dateModified: number;
  size: number;
  kind: number;
}

export const DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS: SftpBrowserColumnWidths = {
  name: 360,
  dateModified: 168,
  size: 96,
  kind: 96
};

export const MIN_SFTP_BROWSER_COLUMN_WIDTHS: SftpBrowserColumnWidths = {
  name: 180,
  dateModified: 140,
  size: 72,
  kind: 72
};

const SFTP_BROWSER_COLUMN_KEYS: SftpBrowserColumnKey[] = ['name', 'dateModified', 'size', 'kind'];

export function normalizeSftpBrowserColumnWidths(
  value: Partial<Record<SftpBrowserColumnKey, unknown>> | null | undefined
): SftpBrowserColumnWidths {
  const source = value ?? {};
  return SFTP_BROWSER_COLUMN_KEYS.reduce<SftpBrowserColumnWidths>(
    (result, key) => {
      const nextValue = source[key];
      if (typeof nextValue !== 'number' || !Number.isFinite(nextValue)) {
        result[key] = DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS[key];
        return result;
      }
      result[key] = Math.max(MIN_SFTP_BROWSER_COLUMN_WIDTHS[key], Math.round(nextValue));
      return result;
    },
    { ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS }
  );
}

export type HomeHostViewMode = 'grid' | 'list';

/**
 * 등록된 tailnet 하나. **auth key 는 여기 없다** — 비밀이라 기기 로컬 암호화 저장소에
 * 따로 두고, 이 레코드에는 키가 설정돼 있는지 여부만 남긴다. 그래야 나중에 tailnet 설정이
 * 기기 간 동기화 대상이 되어도 키가 딸려 나가지 않는다.
 *
 * 노드 상태(노드키)도 여기 없다. 기기마다 자기 노드를 가지므로 공유하면 서로를 밀어낸다.
 */
export interface TailnetRecord {
  id: string;
  /** 사용자가 알아볼 이름. */
  label: string;
  /** 비면 Tailscale, 채우면 Headscale 같은 다른 컨트롤 플레인. */
  controlUrl?: string;
  /**
   * 활동이 멈추면 노드를 지우도록 요청한다. 컨트롤 플레인이 최종 판단하며, Headscale 의
   * OIDC 경로는 이를 무시하는 알려진 버그가 있다.
   */
  ephemeral?: boolean;
  /** auth key 가 저장돼 있는지. 키 자체는 암호화 저장소에 있다. */
  hasAuthKey?: boolean;
  /**
   * 이 설정이 묶인 tailnet 의 이름. 처음 연결에 성공했을 때 컨트롤 플레인이 알려 준 값이다.
   *
   * 대조용이다. Tailscale 기본 서버는 설정에 서버 주소조차 없어서, 다른 기기에서(또는 같은
   * 기기에서 나중에) 다른 계정으로 로그인하면 조용히 다른 tailnet 에 붙는다. 그 tailnet 에
   * 같은 이름의 다른 머신이 있으면 엉뚱한 곳으로 연결을 시도하게 된다.
   */
  tailnetName?: string;
  /** 마지막으로 이 설정을 인증한 계정. 안내용이고 대조에는 쓰지 않는다 — 한 tailnet 에 여러 사용자가 있는 것은 정상이다. */
  loginName?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 동기화에 실리는 tailnet. 레코드에 auth key 를 합친 것이다.
 *
 * 로컬 저장은 둘로 나뉜다 — 레코드는 data.tailnets, 키는 OS 암호화 저장소인
 * secure.tailnetAuthKeysById. 동기화는 이 둘을 합쳐 볼트 키로 암호화해 올린다. 서버는
 * 암호문만 보관하므로 키가 실려도 서버가 볼 수 없다. AWS 프로필과 같은 구조다.
 *
 * 기기별 상태(tailscaled.state 의 머신키·노드키)는 여기 없다. 기기마다 tailnet 안에서
 * 별개의 노드라 공유하면 안 되는 물건이다.
 */
export interface TailnetPayload extends TailnetRecord {
  /** 없으면 브라우저 로그인으로 등록하는 tailnet 이다. */
  authKey?: string;
}

export interface AppSettings extends TerminalAppearanceSettings {
  theme: AppTheme;
  /** UI 언어. 생략/undefined 는 'system'(OS 언어 따르기). */
  language?: AppLanguage;
  homeHostViewMode?: HomeHostViewMode;
  sftpBrowserColumnWidths: SftpBrowserColumnWidths;
  sftpConflictPolicy?: SftpConflictPolicy;
  sftpPreserveMtime?: boolean;
  sftpPreservePermissions?: boolean;
  editorMaxFileSizeMB?: number;
  sessionReplayRetentionCount: number;
  commandNotificationsEnabled: boolean;
  commandNotificationThresholdSeconds: number;
  commandNotificationOnlyWhenUnfocused: boolean;
  commandNotificationOnFailure: boolean;
  commandNotificationSound: boolean;
  autoReconnectEnabled: boolean;
  autoReconnectMaxAttempts: number;
  autoReconnectBaseDelayMs: number;
  autoReconnectMaxDelayMs: number;
  /** 접속한 원격 호스트의 CPU·메모리·네트워크를 터미널 하단에 표시할지. 기본 꺼짐. */
  hostMetricsEnabled: boolean;
  /** tmux prefix 키 토큰("C-b"/"C-a"/"C-Space" …). 비우면 Ctrl-b. control mode pane 에서 항상 동작. */
  tmuxPrefixKey?: string;
  /**
   * 서브셸(중첩 ssh·sudo su·docker exec 등) 진입을 감지하면 OSC 133/7 셸 통합을 자동으로
   * 다시 주입할지 여부. 생략/undefined 는 활성으로 취급하며, 끄려면 명시적으로 false.
   */
  subshellReinjectEnabled?: boolean;
  /** 서브셸 감지에 추가할 사용자 정의 정규식(명령어 prefix). 기본 목록에 더해진다. */
  subshellReinjectPatterns?: string[];
  ai?: AiSettings;
  serverUrl: string;
  serverUrlOverride?: string | null;
  /**
   * 이 기기가 tailnet 에 등록할 때 쓸 이름. null 이면 코어가 정하는 기본값(`dolgate-<기기이름>`).
   *
   * **기기 로컬 전용이다 — 동기화하지 않는다.** 노드는 기기마다 별개라 이름이 같으면
   * 컨트롤 플레인이 `-1`, `-2` 를 붙인다. settings 는 동기화 대상이 아니므로 여기 두면 된다.
   *
   * 선택 필드가 아니다. 이 값이 코어까지 가려면 객체를 필드별로 다시 만드는 곳을 세 군데
   * 지나는데, 선택으로 두면 한 곳만 빠뜨려도 컴파일러가 잡지 못하고 조용히 undefined 가 된다
   * — 화면에는 저장된 것처럼 보이면서 반영만 안 되는, 원인 찾기 어려운 실패다.
   */
  tailnetHostname: string | null;
  /**
   * RDP 호스트별로 고른 모니터. **기기 로컬 전용이다 — 동기화하지 않는다.**
   *
   * 붙어 있는 모니터가 기기마다 다르므로 호스트 레코드(동기화 대상)에 둘 수 없다. 호스트에는
   * "전체 모니터를 쓸 것인가"만 남고 세부 선택이 여기 있다.
   *
   * `tailnetHostname` 과 같은 이유로 선택 필드가 아니다 — 설정 객체를 필드별로 다시 만드는 곳을
   * 여러 군데 지나는데, 선택으로 두면 한 곳만 빠뜨려도 컴파일러가 못 잡고 조용히 사라진다.
   */
  rdpMonitorsByHostId: Record<string, RdpMonitorSelection[]>;
  dismissedUpdateVersion?: string | null;
  updatedAt: string;
}

export interface CommandNotificationSettings {
  commandNotificationsEnabled: boolean;
  commandNotificationThresholdSeconds: number;
  commandNotificationOnlyWhenUnfocused: boolean;
  commandNotificationOnFailure: boolean;
  commandNotificationSound: boolean;
}

export const DEFAULT_COMMAND_NOTIFICATION_SETTINGS: CommandNotificationSettings = {
  commandNotificationsEnabled: true,
  commandNotificationThresholdSeconds: 30,
  commandNotificationOnlyWhenUnfocused: true,
  commandNotificationOnFailure: false,
  commandNotificationSound: false
};

// HostMetricsSettings 는 원격 호스트 부하 표시를 제어한다.
//
// 기본 켜짐이다. 원격에 주기적으로 명령을 보내지만 (1) 자동완성 generator 가 쓰는 보조
// 채널을 그대로 재사용해 폴링마다 SSH 채널을 새로 열지 않고, (2) 읽는 것이 /proc 몇 줄이며,
// (3) 보고 있는 탭에서만 돈다. 자동완성이 이미 기본으로 원격 명령을 돌리는 것에 비하면 가볍다.
// 끄고 싶으면 설정에서 끈다.
//
// 주기는 설정으로 열지 않고 고정한다(POLL_INTERVAL_MS) — 조절할 만한 값이 아니고 항목만 늘어난다.
export interface HostMetricsSettings {
  hostMetricsEnabled: boolean;
}

export const DEFAULT_HOST_METRICS_SETTINGS: HostMetricsSettings = {
  hostMetricsEnabled: true
};

export const MIN_COMMAND_NOTIFICATION_THRESHOLD_SECONDS = 1;
export const MAX_COMMAND_NOTIFICATION_THRESHOLD_SECONDS = 86400;

export function clampCommandNotificationThresholdSeconds(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_COMMAND_NOTIFICATION_SETTINGS.commandNotificationThresholdSeconds;
  }
  return Math.min(
    MAX_COMMAND_NOTIFICATION_THRESHOLD_SECONDS,
    Math.max(MIN_COMMAND_NOTIFICATION_THRESHOLD_SECONDS, Math.round(value))
  );
}

// AutoReconnectSettings는 예기치 않은 연결 끊김 시 자동 재연결 동작을 제어한다.
export interface AutoReconnectSettings {
  autoReconnectEnabled: boolean;
  autoReconnectMaxAttempts: number;
  autoReconnectBaseDelayMs: number;
  autoReconnectMaxDelayMs: number;
}

export const DEFAULT_AUTO_RECONNECT_SETTINGS: AutoReconnectSettings = {
  autoReconnectEnabled: true,
  autoReconnectMaxAttempts: 10,
  autoReconnectBaseDelayMs: 1000,
  // 상한 8초: 네트워크 복구 즉시 재시도는 navigator.onLine(online 이벤트)에 의존하는데
  // Windows Electron 에선 이 감지가 늦거나 누락된다(맥은 정확). 상한이 30초면 복구 후
  // 다음 백오프까지 한참 기다리게 되므로, 이벤트 감지에 기대지 않고 8초 안에 재시도하도록 낮춘다.
  autoReconnectMaxDelayMs: 8000
};

export const MIN_AUTO_RECONNECT_MAX_ATTEMPTS = 1;
export const MAX_AUTO_RECONNECT_MAX_ATTEMPTS = 100;
export const MIN_AUTO_RECONNECT_DELAY_MS = 250;
export const MAX_AUTO_RECONNECT_DELAY_MS = 300000;

export function clampAutoReconnectMaxAttempts(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_AUTO_RECONNECT_SETTINGS.autoReconnectMaxAttempts;
  }
  return Math.min(
    MAX_AUTO_RECONNECT_MAX_ATTEMPTS,
    Math.max(MIN_AUTO_RECONNECT_MAX_ATTEMPTS, Math.round(value))
  );
}

export function clampAutoReconnectDelayMs(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_AUTO_RECONNECT_SETTINGS.autoReconnectBaseDelayMs;
  }
  return Math.min(
    MAX_AUTO_RECONNECT_DELAY_MS,
    Math.max(MIN_AUTO_RECONNECT_DELAY_MS, Math.round(value))
  );
}

// AiSettings는 SSH/EC2 세션용 AI 어시스턴트(v1: BYO API 키)의 공개 설정이다.
// API 키는 여기 담지 않고 SecretStore(키체인, account: `ai:apiKey:<providerId>`)에만 저장하며,
// 동기화 대상이 아니다(getSyncedTerminalPreferences가 터미널 테마만 직렬화 → 자동 로컬 유지).
export type AiProviderId = 'openai-compat' | 'anthropic' | 'codex';
// 웹 검색 백엔드. duckduckgo=키리스(스크레이프), tavily=BYO 키(더 안정·고품질).
export type AiSearchBackend = 'duckduckgo' | 'tavily';

export interface AiSettings {
  enabled: boolean;
  providerId: AiProviderId;
  /** openai-compat 전용 베이스 URL(예: http://localhost:11434/v1). anthropic 은 무시. */
  baseUrl?: string;
  model: string;
  /** 0..2 로 clamp. undefined 면 provider 기본값 사용. */
  temperature?: number;
  /** 모델 컨텍스트 창(토큰). 입력이 이 예산을 넘으면 오래된 대화부터 잘라낸다. */
  contextTokens?: number;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  providerId: 'openai-compat',
  // 미설정(빈 값) = 프로바이더 기본 호스트 사용. UI 는 placeholder 로만 안내한다.
  baseUrl: undefined,
  // 빈 값 → UI 가 모델 선택을 강제(폐기될 수 있는 모델 id 하드코딩 회피).
  model: '',
  temperature: undefined,
  contextTokens: 128000
};

// contextTokens 정규화: 양의 정수만, 그 외엔 undefined(기본값 사용).
export function normalizeAiTokenLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export const MIN_AI_TEMPERATURE = 0;
export const MAX_AI_TEMPERATURE = 2;

// temperature 는 정수가 아니라 실수(0.0~2.0)이므로 round 하지 않는다.
export function clampAiTemperature(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_AI_SETTINGS.temperature ?? 0;
  }
  return Math.min(MAX_AI_TEMPERATURE, Math.max(MIN_AI_TEMPERATURE, value));
}

// openai-compat 의 기본 호스트. 미설정(undefined)과 의미가 같으므로 저장하지 않는다.
const DEFAULT_OPENAI_COMPAT_BASE_URL = 'https://api.openai.com/v1';

// AI 프로바이더 요청에 쓰는 베이스 URL 정규화.
// 빈 값이면 undefined, http/https 만 허용, 후행 슬래시 제거, 파싱 실패 시 undefined.
// 기본 호스트와 같은 값은 undefined 로 접는다(미설정과 동일 — 과거 기본값으로 저장된 설정 마이그레이션 겸용).
export function normalizeAiBaseUrl(value: string | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    const normalized = url.toString().replace(/\/+$/, '');
    return normalized === DEFAULT_OPENAI_COMPAT_BASE_URL ? undefined : normalized;
  } catch {
    return undefined;
  }
}

// AutoReconnectPolicy는 호스트별 자동 재연결 정책 오버라이드를 표현한다.
export type AutoReconnectPolicy = 'inherit' | 'on' | 'off';

export type TerminalAutocompleteShell = 'bash' | 'zsh';

export type TerminalAutocompleteStatus =
  | 'probing'
  | 'ready'
  | 'degraded'
  | 'unsupported';

export interface TerminalAutocompleteCapability {
  sessionId: string;
  status: TerminalAutocompleteStatus;
  shell?: TerminalAutocompleteShell;
  sources: Array<'history' | 'executable' | 'session-history'>;
  reasonCode?:
    | 'unsupported-shell'
    | 'probe-timeout'
    | 'metadata-unavailable';
}

export interface TerminalAutocompleteExecutable {
  name: string;
  path?: string;
}

export interface TerminalAutocompleteSnapshot {
  sessionId: string;
  shell: TerminalAutocompleteShell;
  revision: number;
  history: string[];
  executables: TerminalAutocompleteExecutable[];
  truncated: boolean;
}

export interface TerminalAutocompleteShellState {
  sessionId: string;
  kind: 'shellReady' | 'promptStart' | 'commandStart' | 'commandEnd';
  shell?: TerminalAutocompleteShell;
  cwd?: string;
  command?: string;
}

export interface DesktopBootstrapSnapshot {
  hosts: HostRecord[];
  groups: GroupRecord[];
  tabs: TerminalTab[];
  settings: AppSettings;
  localHomePath: string;
  localHomeListing: DirectoryListing;
  portForwardSnapshot: PortForwardListSnapshot;
  dnsOverrides: DnsOverrideResolvedRecord[];
  knownHosts: KnownHostRecord[];
  activityLogs: ActivityLogRecord[];
  keychainEntries: SecretMetadataRecord[];
}

export interface DesktopSyncedWorkspaceSnapshot {
  hosts: HostRecord[];
  groups: GroupRecord[];
  settings: AppSettings;
  portForwardSnapshot: PortForwardListSnapshot;
  dnsOverrides: DnsOverrideResolvedRecord[];
  knownHosts: KnownHostRecord[];
  keychainEntries: SecretMetadataRecord[];
}

export interface TerminalPreferencesRecord {
  id: 'global-terminal';
  globalTerminalThemeId: GlobalTerminalThemeId;
  updatedAt: string;
}

// E2EE 볼트 게이트가 렌더러에 보여줄 최소 상태. wrapped DEK/KDF 등 민감 재료는
// 메인 프로세스에만 두고 status 만 내보낸다.
export type AuthVaultStatus =
  | 'legacy'
  | 'setup-required'
  | 'locked'
  | 'unlocked'
  | 'error';

// AuthState는 desktop 로그인 게이트와 세션 복구가 읽는 최소 상태다.
export interface AuthState {
  status: AuthStatus;
  session?: AuthSession | null;
  offline?: {
    expiresAt: string;
    lastOnlineAt: string;
    reason: string;
  } | null;
  errorMessage?: string | null;
  // E2EE 볼트 게이트 상태. v2 도입 이전 코드가 만든 상태 객체에는 없다(= legacy 취급).
  // canMigrate: legacy(v1) 계정이 E2EE 로 전환 가능한 서버에 붙어 있는지 —
  // 셀프호스팅 구버전 서버에서는 전환 프롬프트를 띄우지 않기 위한 판별값.
  vault?: {
    status: AuthVaultStatus;
    canMigrate?: boolean;
    migrationRequired?: boolean;
    errorMessage?: string;
  } | null;
  // 현재 붙어 있는 서버가 지원하는 로그인 기능. 설정의 패스키 섹션 노출 게이트로 쓴다.
  // 서버 URL이 바뀌면 /api/info 재조회 전까지 false로 취급한다(서버별 지원이 다르므로).
  capabilities?: {
    webauthn: boolean;
    /**
     * 서버가 계정 데이터 수준(sync_data_floor)을 저장·판정할 수 있는가.
     *
     * 이걸 못 하는 서버(자체 호스팅 옛 버전)에서는 **옛 클라이언트를 막아 주는 장치가 없다** —
     * 우리가 보내는 수준 헤더를 아무도 읽지 않으므로, RDP 호스트를 만들면 그 계정의 옛 기기가
     * 조용히 망가진다. 그래서 이 값이 false 면 RDP 호스트 추가를 열지 않는다.
     *
     * 서버 URL 이 바뀌면 /api/info 재조회 전까지 false 로 본다(webauthn 과 같은 규칙).
     */
    dataFloor: boolean;
  } | null;
}

// PasskeyCredential 은 설정 화면이 보여줄 등록된 패스키 하나의 최소 정보다(민감 재료 없음).
export interface PasskeyCredential {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
}

// SyncStatus는 초기 hydrate와 이후 push 재시도를 UI/서비스가 추적하기 위한 상태다.
export interface SyncStatus {
  status: SyncBootstrapStatus;
  lastSuccessfulSyncAt?: string | null;
  // 원격 스냅샷을 실제로 적용(200)했을 때만 갱신되는 타임스탬프. 304(변경 없음)에는
  // 바뀌지 않는다. 폴링이 값이 달라졌을 때만 워크스페이스를 다시 읽어 낭비를 없앤다.
  lastDataChangeAt?: string | null;
  pendingPush: boolean;
  errorMessage?: string | null;
  awsProfilesServerSupport?: AwsProfilesServerSupport;
  awsSsmServerSupport?: AwsProfilesServerSupport;
  awsSftpServerSupport?: AwsProfilesServerSupport;
  // 서버가 E2EE 볼트(v2)를 지원하는지 — 기존(v1) 유저에게 전환 프롬프트를 띄울지 판단.
  vaultE2eeServerSupport?: AwsProfilesServerSupport;
}

// UpdateReleaseInfo는 GitHub Releases에서 읽어온 배포 메타데이터를 정규화한 형태다.
export interface UpdateReleaseInfo {
  version: string;
  releaseName?: string | null;
  releaseNotes?: string | null;
  publishedAt?: string | null;
}

// UpdateProgressInfo는 다운로드 진행률을 UI가 그대로 렌더링하기 위한 뷰 모델이다.
export interface UpdateProgressInfo {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

// UpdateState는 메인 프로세스 auto updater의 현재 상태 스냅샷이다.
export interface UpdateState {
  enabled: boolean;
  status: UpdateStatus;
  currentVersion: string;
  release?: UpdateReleaseInfo | null;
  progress?: UpdateProgressInfo | null;
  checkedAt?: string | null;
  dismissedVersion?: string | null;
  errorMessage?: string | null;
}

export interface UpdateEvent {
  state: UpdateState;
}

export interface DesktopWindowState {
  isMaximized: boolean;
  /**
   * 창이 전체화면인지. 전체화면에서는 타이틀바를 감추고 상단 가장자리에 포인터를 대면
   * 다시 내려오게 한다 — 원격 화면이나 터미널이 화면을 온전히 쓰게 하기 위해서다.
   */
  isFullScreen: boolean;
}

export interface TerminalThemePreset {
  id: TerminalThemeId;
  title: string;
}

export type ManagedAwsProfileKind = 'static' | 'sso' | 'role';

export interface AwsProfileMetadataRecord {
  id: string;
  name: string;
  kind: ManagedAwsProfileKind;
  updatedAt: string;
}

interface ManagedAwsProfileBase {
  id: string;
  name: string;
  kind: ManagedAwsProfileKind;
  region?: string | null;
  updatedAt: string;
}

export interface ManagedAwsStaticProfilePayload extends ManagedAwsProfileBase {
  kind: 'static';
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ManagedAwsSsoProfilePayload extends ManagedAwsProfileBase {
  kind: 'sso';
  ssoStartUrl: string;
  ssoRegion: string;
  ssoAccountId: string;
  ssoRoleName: string;
}

export interface ManagedAwsRoleProfilePayload extends ManagedAwsProfileBase {
  kind: 'role';
  sourceProfileId: string;
  roleArn: string;
}

export type ManagedAwsProfilePayload =
  | ManagedAwsStaticProfilePayload
  | ManagedAwsSsoProfilePayload
  | ManagedAwsRoleProfilePayload;

export interface AwsProfileSummary {
  id: string | null;
  name: string;
}

export interface AwsExternalProfileImportInput {
  profileNames: string[];
}

export interface AwsExternalProfileImportResult {
  importedProfileNames: string[];
  skippedProfileNames: string[];
}

export interface AwsStaticProfileDraft {
  profileName: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string | null;
}

export interface AwsStaticProfileCreateInput extends AwsStaticProfileDraft {
  kind: "static";
}

export interface AwsSsoProfilePrepareInput {
  profileName: string;
  ssoStartUrl: string;
  ssoRegion: string;
  region?: string | null;
}

export interface AwsSsoProfileAccountOption {
  accountId: string;
  accountName: string;
  emailAddress?: string | null;
}

export interface AwsSsoProfileRoleOption {
  accountId: string;
  roleName: string;
}

export interface AwsSsoProfilePrepareResult {
  preparationToken: string;
  profileName: string;
  ssoSessionName: string;
  ssoStartUrl: string;
  ssoRegion: string;
  region?: string | null;
  accounts: AwsSsoProfileAccountOption[];
  rolesByAccountId: Record<string, AwsSsoProfileRoleOption[]>;
  defaultAccountId?: string | null;
  defaultRoleName?: string | null;
}

export interface AwsSsoProfileCreateInput extends AwsSsoProfilePrepareInput {
  kind: "sso";
  preparationToken: string;
  ssoSessionName: string;
  ssoAccountId: string;
  ssoRoleName: string;
}

export interface AwsRoleProfileCreateInput {
  kind: "role";
  profileName: string;
  sourceProfileId?: string | null;
  sourceProfileName: string;
  roleArn: string;
  region?: string | null;
}

export type AwsProfileCreateInput =
  | AwsStaticProfileCreateInput
  | AwsSsoProfileCreateInput
  | AwsRoleProfileCreateInput;

export interface AwsProfileUpdateInput extends AwsStaticProfileDraft {
  profileName: string;
}

export interface AwsProfileRegionUpdateInput {
  profileName: string;
  region?: string | null;
}

export interface AwsProfileRenameInput {
  profileName: string;
  nextProfileName: string;
}

export type AwsProfileKind =
  | "static"
  | "sso"
  | "role"
  | "credential-process"
  | "unknown";

export const AWS_PROFILE_REGION_OPTIONS = [
  "af-south-1",
  "ap-east-1",
  "ap-east-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-south-1",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-6",
  "ap-southeast-7",
  "ca-central-1",
  "ca-west-1",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "il-central-1",
  "me-central-1",
  "me-south-1",
  "mx-central-1",
  "sa-east-1",
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
] as const;

export interface AwsProfileStatus {
  id: string | null;
  profileName: string;
  available: boolean;
  isSsoProfile: boolean;
  isAuthenticated: boolean;
  configuredRegion?: string | null;
  accountId?: string | null;
  arn?: string | null;
  errorMessage?: string | null;
}

export interface AwsProfileDetails extends AwsProfileStatus {
  kind: AwsProfileKind;
  maskedAccessKeyId?: string | null;
  hasSecretAccessKey: boolean;
  hasSessionToken: boolean;
  roleArn?: string | null;
  sourceProfileId?: string | null;
  sourceProfile?: string | null;
  credentialProcess?: string | null;
  ssoSession?: string | null;
  ssoStartUrl?: string | null;
  ssoRegion?: string | null;
  ssoAccountId?: string | null;
  ssoRoleName?: string | null;
  referencedByProfileNames: string[];
  orphanedSsoSessionName?: string | null;
}

/**
 * Windows 초기 비밀번호를 못 가져온 이유. 화면이 무엇을 안내할지 정하는 값이다.
 *
 * - `no-key`: 개인키를 아직 안 넣었다
 * - `encrypted-key`: 암호가 걸린 PEM (EC2 가 만든 키페어는 암호가 없다)
 * - `wrong-key`: 이 인스턴스의 키페어가 아니거나 RSA 가 아니다(ed25519 는 이 기능을 못 쓴다)
 * - `not-available`: AWS 가 빈 값을 줬다 — 비밀번호를 바꿨거나, 도메인 조인, 또는 부팅 직후
 */
export type AwsWindowsPasswordFailure =
  | 'no-key'
  | 'encrypted-key'
  | 'wrong-key'
  | 'not-available';

export interface AwsWindowsPasswordResult {
  password: string | null;
  reason: AwsWindowsPasswordFailure | null;
}

export interface AwsEc2InstanceSummary {
  instanceId: string;
  name: string;
  availabilityZone?: string | null;
  platform?: string | null;
  privateIp?: string | null;
  /**
   * 이 인스턴스에 연결된 키페어 이름. 없으면 null.
   *
   * Windows 초기 관리자 비밀번호는 이 키페어의 개인키로만 풀린다. 어느 `.pem` 을 찾아야 하는지
   * 화면이 말해 줘야 하고(콘솔도 같은 자리에 보여 준다), null 이면 조회 자체가 불가능하다.
   */
  keyName?: string | null;
  state?: string | null;
  ssmAvailability: "ready" | "unavailable" | "unknown";
  ssmAvailabilityReason?: string | null;
}

export interface AwsEcsClusterSummary {
  clusterArn: string;
  clusterName: string;
  status: string;
  activeServicesCount: number;
  runningTasksCount: number;
  pendingTasksCount: number;
}

export interface AwsEcsClusterListItem {
  clusterArn: string;
  clusterName: string;
  status: string;
  activeServicesCount: number;
  runningTasksCount: number;
  pendingTasksCount: number;
}

export interface AwsEcsServicePortSummary {
  port: number;
  protocol: string;
}

export type AwsEcsServiceExposureKind = "alb" | "nlb" | "service-connect";

export interface AwsMetricHistoryPoint {
  timestamp: string;
  value: number | null;
}

export interface AwsEcsServiceSummary {
  serviceArn: string;
  serviceName: string;
  status: string;
  rolloutState?: string | null;
  rolloutStateReason?: string | null;
  desiredCount: number;
  runningCount: number;
  pendingCount: number;
  launchType?: string | null;
  capacityProviderSummary?: string | null;
  servicePorts: AwsEcsServicePortSummary[];
  exposureKinds: AwsEcsServiceExposureKind[];
  cpuUtilizationPercent?: number | null;
  memoryUtilizationPercent?: number | null;
  configuredCpu?: string | null;
  configuredMemory?: string | null;
  taskDefinitionArn?: string | null;
  taskDefinitionRevision?: number | null;
  latestEventMessage?: string | null;
  deployments?: AwsEcsDeploymentSummary[];
  events?: AwsEcsEventSummary[];
}

export interface AwsEcsDeploymentSummary {
  id: string;
  status: string;
  rolloutState?: string | null;
  rolloutStateReason?: string | null;
  desiredCount?: number | null;
  runningCount?: number | null;
  pendingCount?: number | null;
  taskDefinitionArn?: string | null;
  taskDefinitionRevision?: number | null;
  updatedAt?: string | null;
}

export interface AwsEcsEventSummary {
  id: string;
  message: string;
  createdAt?: string | null;
}

export interface AwsEcsServiceUtilizationSummary {
  serviceName: string;
  cpuUtilizationPercent: number | null;
  memoryUtilizationPercent: number | null;
  cpuHistory: AwsMetricHistoryPoint[];
  memoryHistory: AwsMetricHistoryPoint[];
}

export interface AwsEcsClusterSnapshot {
  profileName: string;
  region: string;
  cluster: AwsEcsClusterSummary;
  services: AwsEcsServiceSummary[];
  metricsWarning?: string | null;
  loadedAt: string;
}

export interface AwsEcsClusterUtilizationSnapshot {
  loadedAt: string;
  warning?: string | null;
  services: AwsEcsServiceUtilizationSummary[];
}

export interface AwsEcsTaskTunnelServiceSummary {
  serviceName: string;
  status: string;
  desiredCount: number;
  runningCount: number;
  pendingCount: number;
}

export interface AwsEcsTaskTunnelContainerSummary {
  containerName: string;
  ports: AwsEcsServicePortSummary[];
}

export interface AwsEcsTaskTunnelServiceDetails {
  serviceName: string;
  containers: AwsEcsTaskTunnelContainerSummary[];
}

export interface AwsEcsServiceTaskContainerSummary {
  containerName: string;
  lastStatus: string | null;
  runtimeId?: string | null;
}

export interface AwsEcsServiceTaskSummary {
  taskArn: string;
  taskId: string;
  lastStatus: string | null;
  enableExecuteCommand: boolean;
  containers: AwsEcsServiceTaskContainerSummary[];
}

export interface AwsEcsServiceLogSupport {
  containerName: string;
  supported: boolean;
  reason?: string | null;
  logGroupName?: string | null;
  logRegion?: string | null;
  logStreamPrefix?: string | null;
}

export interface AwsEcsServiceActionContainerSummary {
  containerName: string;
  ports: AwsEcsServicePortSummary[];
  execEnabled: boolean;
  logSupport: AwsEcsServiceLogSupport;
}

export interface AwsEcsServiceActionContext {
  serviceName: string;
  serviceArn: string;
  taskDefinitionArn?: string | null;
  taskDefinitionRevision?: number | null;
  containers: AwsEcsServiceActionContainerSummary[];
  runningTasks: AwsEcsServiceTaskSummary[];
  deployments: AwsEcsDeploymentSummary[];
  events: AwsEcsEventSummary[];
}

export interface AwsEcsServiceLogEntry {
  id: string;
  timestamp: string;
  message: string;
  ingestionTime?: string | null;
  logStreamName?: string | null;
  taskId?: string | null;
  containerName?: string | null;
}

export interface AwsEcsServiceLogsSnapshot {
  serviceName: string;
  entries: AwsEcsServiceLogEntry[];
  taskOptions: Array<{ taskArn: string; taskId: string }>;
  containerOptions: string[];
  followCursor?: string | null;
  loadedAt: string;
  unsupportedReason?: string | null;
}

export interface AwsHostSshInspectionInput {
  profileName: string;
  region: string;
  instanceId: string;
  availabilityZone?: string | null;
}

export interface AwsHostSshInspectionResult {
  sshPort: number | null;
  recommendedUsername: string | null;
  usernameCandidates: string[];
  status: 'ready' | 'error';
  errorMessage: string | null;
}

export interface WarpgateTargetSummary {
  id: string;
  name: string;
  kind: 'ssh';
}

export interface WarpgateConnectionInfo {
  baseUrl: string;
  sshHost: string;
  sshPort: number;
  username?: string | null;
}

export type WarpgateImportStatus =
  | 'opening-browser'
  | 'waiting-for-login'
  | 'loading-targets'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface WarpgateImportEvent {
  attemptId: string;
  status: WarpgateImportStatus;
  connectionInfo?: WarpgateConnectionInfo | null;
  targets?: WarpgateTargetSummary[] | null;
  errorMessage?: string | null;
}

export interface KeyboardInteractivePrompt {
  label: string;
  echo: boolean;
}

export interface KeyboardInteractiveChallenge {
  sessionId?: string;
  endpointId?: string;
  challengeId: string;
  attempt: number;
  name?: string | null;
  instruction: string;
  prompts: KeyboardInteractivePrompt[];
}

interface PortForwardRuleBaseRecord {
  id: string;
  label: string;
  hostId: string;
  transport: PortForwardTransport;
  bindAddress: string;
  bindPort: number;
  createdAt: string;
  updatedAt: string;
}

export interface SshPortForwardRuleRecord extends PortForwardRuleBaseRecord {
  transport: 'ssh';
  mode: PortForwardMode;
  targetHost?: string | null;
  targetPort?: number | null;
}

export interface AwsSsmPortForwardRuleRecord extends PortForwardRuleBaseRecord {
  transport: 'aws-ssm';
  targetKind: AwsSsmPortForwardTargetKind;
  targetPort: number;
  remoteHost?: string | null;
}

export interface EcsTaskPortForwardRuleRecord extends PortForwardRuleBaseRecord {
  transport: 'ecs-task';
  bindAddress: '127.0.0.1';
  serviceName: string;
  containerName: string;
  targetPort: number;
}

export interface ContainerPortForwardRuleRecord extends PortForwardRuleBaseRecord {
  transport: 'container';
  bindAddress: '127.0.0.1';
  containerId: string;
  containerName: string;
  containerRuntime: HostContainerRuntime;
  networkName: string;
  targetPort: number;
}

// PortForwardRuleRecord는 사용자가 저장한 포워딩 규칙 자체를 표현한다.
export type PortForwardRuleRecord =
  | SshPortForwardRuleRecord
  | AwsSsmPortForwardRuleRecord
  | EcsTaskPortForwardRuleRecord
  | ContainerPortForwardRuleRecord;

interface PortForwardDraftBase {
  label: string;
  hostId: string;
  transport: PortForwardTransport;
  bindAddress: string;
  bindPort: number;
}

export interface SshPortForwardDraft extends PortForwardDraftBase {
  transport: 'ssh';
  mode: PortForwardMode;
  targetHost?: string | null;
  targetPort?: number | null;
}

export interface AwsSsmPortForwardDraft extends PortForwardDraftBase {
  transport: 'aws-ssm';
  targetKind: AwsSsmPortForwardTargetKind;
  targetPort: number;
  remoteHost?: string | null;
}

export interface EcsTaskPortForwardDraft extends PortForwardDraftBase {
  transport: 'ecs-task';
  bindAddress: '127.0.0.1';
  serviceName: string;
  containerName: string;
  targetPort: number;
}

export interface ContainerPortForwardDraft extends PortForwardDraftBase {
  transport: 'container';
  bindAddress: '127.0.0.1';
  containerId: string;
  containerName: string;
  containerRuntime: HostContainerRuntime;
  networkName: string;
  targetPort: number;
}

// PortForwardDraft는 생성/수정 폼에서 사용하는 입력 전용 모델이다.
export type PortForwardDraft =
  | SshPortForwardDraft
  | AwsSsmPortForwardDraft
  | EcsTaskPortForwardDraft
  | ContainerPortForwardDraft;

// PortForwardRuntimeRecord는 현재 메모리에서 살아 있는 실행 상태 스냅샷이다.
export interface PortForwardRuntimeRecord {
  ruleId: string;
  hostId: string;
  transport: PortForwardTransport;
  mode?: PortForwardMode;
  method?: 'ssh-native' | 'ssh-session-proxy' | 'ssm-remote-host';
  bindAddress: string;
  bindPort: number;
  status: PortForwardStatus;
  message?: string;
  updatedAt: string;
  startedAt?: string;
}

export interface PortForwardRuntimeEvent {
  runtime: PortForwardRuntimeRecord;
}

export interface PortForwardListSnapshot {
  rules: PortForwardRuleRecord[];
  runtimes: PortForwardRuntimeRecord[];
}

export type DnsOverrideType = 'linked' | 'static';

interface DnsOverrideRecordBase {
  id: string;
  type: DnsOverrideType;
  hostname: string;
  createdAt: string;
  updatedAt: string;
}

export interface LinkedDnsOverrideRecord extends DnsOverrideRecordBase {
  type: 'linked';
  portForwardRuleId: string;
}

export interface StaticDnsOverrideRecord extends DnsOverrideRecordBase {
  type: 'static';
  address: string;
}

export type DnsOverrideRecord = LinkedDnsOverrideRecord | StaticDnsOverrideRecord;

interface DnsOverrideDraftBase {
  type: DnsOverrideType;
  hostname: string;
}

export interface LinkedDnsOverrideDraft extends DnsOverrideDraftBase {
  type: 'linked';
  portForwardRuleId: string;
}

export interface StaticDnsOverrideDraft extends DnsOverrideDraftBase {
  type: 'static';
  address: string;
}

export type DnsOverrideDraft = LinkedDnsOverrideDraft | StaticDnsOverrideDraft;

export type DnsOverrideResolvedRecord = (DnsOverrideRecord & {
  status: DnsOverrideStatus;
});

export function isLinkedDnsOverrideRecord(value: DnsOverrideRecord): value is LinkedDnsOverrideRecord {
  return value.type === 'linked';
}

export function isStaticDnsOverrideRecord(value: DnsOverrideRecord): value is StaticDnsOverrideRecord {
  return value.type === 'static';
}

export function isLinkedDnsOverrideDraft(value: DnsOverrideDraft): value is LinkedDnsOverrideDraft {
  return value.type === 'linked';
}

export function isStaticDnsOverrideDraft(value: DnsOverrideDraft): value is StaticDnsOverrideDraft {
  return value.type === 'static';
}

export function isSshPortForwardRuleRecord(rule: PortForwardRuleRecord): rule is SshPortForwardRuleRecord {
  return rule.transport === 'ssh';
}

export function isAwsSsmPortForwardRuleRecord(rule: PortForwardRuleRecord): rule is AwsSsmPortForwardRuleRecord {
  return rule.transport === 'aws-ssm';
}

// Snippet은 터미널에 꺼내 쓰는 저장된 명령이다. 다른 엔티티처럼 동기화된다.
// command에는 {{name}} / {{name=default}} 형태의 변수를 넣을 수 있고, 삽입 시 값을
// 입력받아 치환한다. keyword는 자동완성에서 매칭할 짧은 키워드(없으면 label로 매칭).
export interface SnippetRecord {
  id: string;
  label: string;
  command: string;
  keyword?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SnippetDraft {
  label: string;
  command: string;
  keyword?: string | null;
}

export function isEcsTaskPortForwardRuleRecord(rule: PortForwardRuleRecord): rule is EcsTaskPortForwardRuleRecord {
  return rule.transport === 'ecs-task';
}

export function isContainerPortForwardRuleRecord(rule: PortForwardRuleRecord): rule is ContainerPortForwardRuleRecord {
  return rule.transport === 'container';
}

export function isSshPortForwardDraft(rule: PortForwardDraft): rule is SshPortForwardDraft {
  return rule.transport === 'ssh';
}

export function isAwsSsmPortForwardDraft(rule: PortForwardDraft): rule is AwsSsmPortForwardDraft {
  return rule.transport === 'aws-ssm';
}

export function isEcsTaskPortForwardDraft(rule: PortForwardDraft): rule is EcsTaskPortForwardDraft {
  return rule.transport === 'ecs-task';
}

export function isContainerPortForwardDraft(rule: PortForwardDraft): rule is ContainerPortForwardDraft {
  return rule.transport === 'container';
}

export function isLoopbackBindAddress(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1' || normalized.startsWith('127.');
}

export function isDnsOverrideEligiblePortForwardRule(rule: PortForwardRuleRecord): boolean {
  if (rule.transport === 'aws-ssm') {
    return isLoopbackBindAddress(rule.bindAddress);
  }
  if (rule.transport === 'ssh') {
    return rule.mode === 'local' && isLoopbackBindAddress(rule.bindAddress);
  }
  return false;
}

// KnownHostRecord는 신뢰된 호스트 키 한 건을 나타낸다.
export interface KnownHostRecord {
  id: string;
  /**
   * 이 키를 신뢰한 tailnet. 없으면 일반 네트워크에서 신뢰한 것이다.
   *
   * 호스트 이름은 tailnet 안에서만 유효하다 — 다른 tailnet 의 같은 이름은 다른 머신이다.
   * 이것을 키에 넣지 않으면 서로의 호스트 키를 오인해, 신뢰한 적 없는 머신을 신뢰한 것으로
   * 착각하게 된다.
   */
  tailnetId?: string;
  host: string;
  port: number;
  algorithm: string;
  publicKeyBase64: string;
  fingerprintSha256: string;
  createdAt: string;
  lastSeenAt: string;
  updatedAt: string;
}

// HostKeyProbeResult는 연결 전 서버에서 읽어온 실제 호스트 키와 저장된 신뢰 레코드 비교 결과다.
export interface HostKeyProbeResult {
  hostId: string;
  hostLabel: string;
  host: string;
  port: number;
  targetDescription?: string | null;
  algorithm: string;
  publicKeyBase64: string;
  fingerprintSha256: string;
  status: KnownHostTrustStatus;
  existing?: KnownHostRecord | null;
}

// KnownHostTrustInput은 probe 결과에서 저장에 필요한 필드만 추려낸 형태다.
export interface KnownHostTrustInput {
  hostId: string;
  hostLabel: string;
  /** 이 신뢰가 어느 tailnet 안에서인지. 없으면 일반 네트워크다. */
  tailnetId?: string;
  host: string;
  port: number;
  algorithm: string;
  publicKeyBase64: string;
  fingerprintSha256: string;
}

// ActivityLogRecord는 앱 활동 로그 화면이 그대로 렌더링하는 구조다.
export interface SessionLifecycleLogMetadata {
  sessionId: string;
  hostId: string;
  hostLabel: string;
  title: string;
  connectionDetails?: string | null;
  connectionKind: SessionConnectionKind;
  connectedAt: string;
  disconnectedAt?: string | null;
  durationMs?: number | null;
  status: SessionLifecycleStatus;
  disconnectReason?: string | null;
  recordingId?: string | null;
  hasReplay?: boolean | null;
}

export interface PortForwardLifecycleLogMetadata {
  ruleId: string;
  ruleLabel: string;
  hostId: string;
  hostLabel: string;
  transport: PortForwardTransport;
  mode: PortForwardMode;
  bindAddress: string;
  bindPort: number;
  targetSummary: string;
  startedAt: string;
  stoppedAt?: string | null;
  durationMs?: number | null;
  status: PortForwardLifecycleStatus;
  endReason?: string | null;
}

export interface SftpLifecycleLogMetadata {
  endpointId: string;
  hostId: string;
  hostLabel: string;
  title: string;
  startedAt: string;
  connectedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
  status: SftpLifecycleStatus;
  endReason?: string | null;
  uploadedCount: number;
  downloadedCount: number;
  remoteCopyCount: number;
  uploadedBytes: number;
  downloadedBytes: number;
  remoteCopyBytes: number;
  mkdirCount: number;
  renameCount: number;
  chmodCount: number;
  chownCount: number;
  deleteCount: number;
  errorCount: number;
  visitedPathCount: number;
  lastPath?: string | null;
}

export interface ContainerLifecycleLogMetadata {
  lifecycleId: string;
  hostId: string;
  hostLabel: string;
  workspaceKind: ContainerWorkspaceKind;
  transport: ContainerLifecycleTransport;
  runtime?: HostContainerRuntime | null;
  startedAt: string;
  connectedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
  status: ContainerLifecycleStatus;
  refreshCount: number;
  errorCount: number;
  resourceCount?: number | null;
  lastError?: string | null;
  endReason?: string | null;
}

export interface ContainerActionLogMetadata {
  actionId: string;
  hostId: string;
  hostLabel: string;
  containerId: string;
  containerName?: string | null;
  runtime?: HostContainerRuntime | null;
  action: HostContainerAction;
  status: ContainerActionStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  errorMessage?: string | null;
}

export interface SessionReplayOutputEntry {
  type: 'output';
  atMs: number;
  dataBase64: string;
}

export interface SessionReplayResizeEntry {
  type: 'resize';
  atMs: number;
  cols: number;
  rows: number;
}

export type SessionReplayEntry =
  | SessionReplayOutputEntry
  | SessionReplayResizeEntry;

export interface SessionReplayRecording {
  recordingId: string;
  sessionId: string;
  hostId: string;
  hostLabel: string;
  title: string;
  connectionDetails?: string | null;
  connectionKind: SessionConnectionKind;
  connectedAt: string;
  disconnectedAt: string;
  durationMs: number;
  initialCols: number;
  initialRows: number;
  entries: SessionReplayEntry[];
}

export interface ActivityLogRecord {
  id: string;
  level: ActivityLogLevel;
  category: ActivityLogCategory;
  kind?: ActivityLogKind;
  /**
   * 기록 당시 언어로 만들어진 문구. messageKey 가 없는 예전 기록을 그리기 위한
   * 폴백이며, 언어를 바꿔도 이 값은 바뀌지 않는다.
   */
  message: string;
  /** 번역 키. 있으면 화면은 이 키로 현재 언어에 맞춰 다시 그린다. */
  messageKey?: string;
  /** messageKey 의 보간 값(개수·이름 등). */
  messageParams?: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt?: string;
}

// SecretMetadataRecord는 원문 secret 없이 저장 위치와 존재 여부만 표현한다.
export interface SecretMetadataRecord {
  secretRef: string;
  label: string;
  /**
   * 이 자격증명이 어느 프로토콜용인가.
   *
   * 없으면 SSH 로 본다 — 이 필드가 생기기 전에 만든 것은 모두 SSH 용이다. RDP 목록에 SSH 자격증명
   * 이 섞여 나오면 고를 수 없는 항목만 늘어난다(계정이 없으니 붙지 못한다).
   *
   * VNC 는 비밀번호 하나뿐이다 — 계정도 키도 쓰지 않고 **8자만 유효하다**(규격이 DES 키로 쓰려고
   * 잘라낸다). 그래서 SSH·RDP 자격증명과 섞어 보여줄 수 없다.
   */
  kind?: 'ssh' | 'rdp' | 'vnc' | null;
  /**
   * 이 자격증명이 가리키는 계정. RDP 는 계정이 자격증명에 딸린다 — Windows 의
   * `DOMAIN\user`+비밀번호가 본래 한 묶음이고, 같은 계정을 여러 호스트에 쓸 때 다시 적지
   * 않아도 된다.
   *
   * 평문이다. 사용자 이름은 비밀이 아니고, 목록에 `Administrator@CORP` 로 보여주거나 접속할 때
   * 복호화 없이 읽어야 한다. `persistSecret` 이 번들에서 그대로 옮겨 적으므로 값이 갈리지 않는다.
   *
   * SSH 는 아직 호스트 레코드가 계정을 갖는다(나중에 정리).
   */
  username?: string | null;
  domain?: string | null;
  hasPassword: boolean;
  hasPassphrase: boolean;
  hasManagedPrivateKey: boolean;
  hasCertificate: boolean;
  privateKeyEncrypted?: boolean;
  keyAlgorithm?: string;
  keyCurve?: string;
  keyBits?: number;
  privateKeyCipher?: string;
  privateKeyKdfRounds?: number;
  passphraseSaved?: boolean;
  linkedHostCount: number;
  updatedAt: string;
}

export type SshCertificateValidityStatus =
  | 'valid'
  | 'expired'
  | 'not_yet_valid'
  | 'invalid';

export interface SshCertificateInfo {
  status: SshCertificateValidityStatus;
  validAfter?: string | null;
  validBefore?: string | null;
  principals?: string[];
  keyId?: string | null;
  serial?: string | null;
}

// ManagedSecretPayload는 서버 sync와 로컬 keychain이 공유하는 실제 secret 본문이다.
// privateKeyPem은 새 기기에서도 바로 SSH 접속이 가능하도록 PEM 전체를 저장한다.
export interface ManagedSecretPayload {
  secretRef: string;
  label: string;
  /** 이 자격증명이 어느 프로토콜용인가. [[SecretMetadataRecord]].kind 참고. */
  kind?: 'ssh' | 'rdp' | 'vnc';
  /** 이 자격증명의 계정. [[SecretMetadataRecord]].username 참고. */
  username?: string;
  domain?: string;
  password?: string;
  passphrase?: string;
  privateKeyPem?: string;
  certificateText?: string;
  publicKey?: string;
  publicKeyFingerprintSha256?: string;
  keyAlgorithm?: string;
  privateKeyEncrypted?: boolean;
  keyCurve?: string;
  keyBits?: number;
  privateKeyCipher?: string;
  privateKeyKdfRounds?: number;
  passphraseSaved?: boolean;
  generatedByApp?: boolean;
  /**
   * @deprecated 환경변수는 이제 호스트 레코드([[SshHostRecord]].env)에 저장된다. 시크릿 공유 시
   * 다른 호스트로 번지던 문제 때문에 분리했다. 이 필드는 구버전 데이터의 읽기 폴백/마이그레이션용으로만 남긴다.
   */
  env?: HostEnvVar[];
  updatedAt: string;
}

export interface LoadedManagedSecretPayload extends ManagedSecretPayload {
  certificateInfo?: SshCertificateInfo;
}

/**
 * 자격증명 페이로드를 목록용 메타데이터로 투영한다.
 *
 * **왜 공용인가:** 이 투영은 필드를 나열하는 화이트리스트라, 페이로드에 필드가 늘 때 한 곳이라도
 * 빠뜨리면 그 경로로 들어온 값이 조용히 증발한다. `kind` 가 실제로 그랬다 — pull 한 번에 RDP
 * 자격증명이 전부 SSH 취급으로 강등돼 RDP 폼 목록에서 사라졌다. 그때 같은 투영이 세 곳(동기화
 * pull·번들 가져오기·모바일)에 복사돼 있어서 세 곳을 각각 고쳐야 했고, 다음에 또 빠뜨리지 않게
 * 막는 것은 "함께 갱신할 것" 주석뿐이었다. 한 곳으로 모으면 빠뜨리는 일 자체가 불가능해진다.
 *
 * `linkedHostCount`·`updatedAt` 은 페이로드에서 나오지 않으므로 호출부가 준다 — 연결된 호스트
 * 수는 그 시점의 호스트 목록에서 세고, 시각의 기준은 경로마다 다르다(동기화는 페이로드의 값,
 * 가져오기는 번들에 적힌 값).
 */
export function projectSecretMetadata(
  secret: ManagedSecretPayload,
  context: { linkedHostCount: number; updatedAt: string },
): SecretMetadataRecord {
  return {
    secretRef: secret.secretRef,
    label: secret.label,
    kind: secret.kind ?? null,
    username: secret.username?.trim() || null,
    domain: secret.domain?.trim() || null,
    hasPassword: Boolean(secret.password),
    hasPassphrase: Boolean(secret.passphrase),
    hasManagedPrivateKey: Boolean(secret.privateKeyPem),
    hasCertificate: Boolean(secret.certificateText),
    privateKeyEncrypted: secret.privateKeyEncrypted,
    keyAlgorithm: secret.keyAlgorithm,
    keyCurve: secret.keyCurve,
    keyBits: secret.keyBits,
    privateKeyCipher: secret.privateKeyCipher,
    privateKeyKdfRounds: secret.privateKeyKdfRounds,
    passphraseSaved: secret.passphraseSaved,
    linkedHostCount: context.linkedHostCount,
    updatedAt: context.updatedAt,
  };
}

export interface LinkedHostSummary {
  id: string;
  label: string;
  hostname: string;
  username: string;
}

// FileEntry는 local/remote 파일 브라우저가 공통으로 쓰는 단일 파일 메타데이터 모델이다.
export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: string;
  kind: FileEntryKind;
  permissions?: string;
  uid?: number;
  gid?: number;
  owner?: string;
  group?: string;
}

// DirectoryListing은 특정 경로의 목록 응답을 표현한다.
export interface DirectoryListing {
  path: string;
  entries: FileEntry[];
  warnings?: string[];
}

export interface FileSystemRoot {
  label: string;
  path: string;
}

// SftpEndpointSummary는 현재 패널이 붙어 있는 remote endpoint 정보를 표현한다.
export interface SftpEndpointSummary {
  id: string;
  kind: 'remote';
  hostId: string;
  title: string;
  path: string;
  connectedAt: string;
  sudoStatus?: SftpSudoStatus;
}

export type SftpSudoStatus =
  | 'unknown'
  | 'probing'
  | 'root'
  | 'passwordless'
  | 'passwordRequired'
  | 'unavailable';

export interface SftpPrincipal {
  kind: 'user' | 'group';
  name: string;
  id: number;
  displayName?: string;
}

export interface SftpHostSelectionState {
  query: string;
  selectedHostId?: string | null;
}

export interface SftpPaneState {
  id: SftpPaneId;
  sourceKind: SftpEndpointKind;
  currentPath: string;
  listing?: DirectoryListing | null;
  endpoint?: SftpEndpointSummary | null;
  isLoading: boolean;
  filterQuery: string;
  history: string[];
  historyIndex: number;
  selectedPaths: string[];
  hostSelection: SftpHostSelectionState;
  errorMessage?: string | null;
}

export interface TransferJob {
  id: string;
  sourceLabel: string;
  targetLabel: string;
  itemCount: number;
  bytesTotal: number;
  bytesCompleted: number;
  speedBytesPerSecond?: number | null;
  etaSeconds?: number | null;
  status: 'queued' | 'running' | 'paused' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  activeItemName?: string | null;
  errorMessage?: string | null;
  errorCode?: 'permission_denied' | 'not_found' | 'operation_unsupported' | 'connection_lost' | 'unknown';
  errorOperation?: string | null;
  errorPath?: string | null;
  errorItemName?: string | null;
  detailMessage?: string | null;
  completedItemCount?: number;
  failedItemCount?: number;
  failedItems?: TransferFailedItem[];
  updatedAt: string;
  request?: TransferStartInput;
}

export interface TransferFailedItem {
  item: TransferItemInput;
  errorMessage: string;
  errorCode?: TransferJob['errorCode'];
  errorOperation?: string | null;
  errorPath?: string | null;
}

export interface TransferJobEvent {
  job: TransferJob;
}

export interface SftpConnectionProgressEvent {
  endpointId: string;
  hostId: string;
  stage: SftpConnectionStage;
  message: string;
  reasonCode?: AwsSftpDiagnosticReasonCode;
  diagnosticId?: string;
  details?: AwsSftpDiagnosticDetails;
}

export interface ContainerConnectionProgressEvent {
  endpointId: string;
  hostId: string;
  stage: ConnectionProgressStage;
  message: string;
}

export interface HostContainerSummary {
  id: string;
  name: string;
  runtime: HostContainerRuntime;
  image: string;
  status: string;
  createdAt: string;
  ports: string;
}

export interface HostContainerListResult {
  hostId: string;
  runtime: HostContainerRuntime | null;
  unsupportedReason?: string | null;
  containers: HostContainerSummary[];
}

export interface HostContainerMountSummary {
  type: string;
  source: string;
  destination: string;
  mode?: string | null;
  readOnly: boolean;
}

export interface HostContainerNetworkSummary {
  name: string;
  ipAddress?: string | null;
  aliases: string[];
}

export interface HostContainerPortBinding {
  hostIp?: string | null;
  hostPort?: number | null;
}

export interface HostContainerPortOption {
  containerPort: number;
  protocol: string;
  publishedBindings: HostContainerPortBinding[];
}

export interface HostContainerDetails {
  id: string;
  name: string;
  runtime: HostContainerRuntime;
  image: string;
  status: string;
  createdAt: string;
  command: string;
  entrypoint: string;
  mounts: HostContainerMountSummary[];
  networks: HostContainerNetworkSummary[];
  ports: HostContainerPortOption[];
  environment: Array<{ key: string; value: string }>;
  labels: Array<{ key: string; value: string }>;
}

export interface HostContainerLogsSnapshot {
  hostId: string;
  containerId: string;
  runtime: HostContainerRuntime;
  lines: string[];
  cursor: string | null;
}

export interface HostContainerStatsSample {
  hostId: string;
  containerId: string;
  runtime: HostContainerRuntime;
  recordedAt: string;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
}

export interface HostContainerStatsSeries {
  hostId: string;
  containerId: string;
  samples: HostContainerStatsSample[];
}

export interface HostContainerLogSearchResult {
  hostId: string;
  containerId: string;
  runtime: HostContainerRuntime;
  query: string;
  lines: string[];
  matchCount: number;
}

export type TransferEndpointRef =
  | {
      kind: 'local';
      path: string;
    }
  | {
      kind: 'remote';
      path: string;
      endpointId: string;
    };

export interface TransferItemInput {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

export interface TransferStartInput {
  source: TransferEndpointRef;
  target: TransferEndpointRef;
  items: TransferItemInput[];
  conflictResolution: ConflictResolution;
  preserveMetadata?: {
    mtime?: boolean;
    permissions?: boolean;
  };
  retryOfJobId?: string;
}

export type TerminalConnectionStage =
  | ConnectionProgressStage
  | 'host-key-check'
  | 'awaiting-host-trust'
  | 'retrying-session'
  | 'reconnecting'
  | 'connecting'
  /**
   * 경유할 SSH 호스트에 붙는 중. VNC 가 SSH 터널로 갈 때 지나는 첫 관문이다.
   *
   * 이 두 단계는 세션 자신의 프로토콜이 아니라 그 앞의 통로를 말한다 — 거기서 막히는 일이 흔하고,
   * 구분하지 않으면 "연결 실패" 가 원격 탓인지 통로 탓인지 알 수 없다.
   */
  | 'ssh-tunnel-gateway'
  /** 터널이 열렸다. 이제 그 로컬 주소로 원격 프로토콜을 협상한다. */
  | 'ssh-tunnel-open'
  | 'awaiting-credentials'
  | 'waiting-interactive-auth'
  | 'waiting-shell';

export type TerminalConnectionBlockingKind = 'none' | 'dialog' | 'panel' | 'browser';
export type TerminalSessionSource = 'host' | 'local';
export type SessionShareStatus = 'inactive' | 'starting' | 'active' | 'error';
export type SessionShareSnapshotKind = 'refresh' | 'resync';

export interface SessionShareTerminalAppearance {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
}

export interface SessionShareViewportPx {
  width: number;
  height: number;
}

export interface SessionShareState {
  status: SessionShareStatus;
  shareUrl: string | null;
  inputEnabled: boolean;
  viewerCount: number;
  errorMessage?: string | null;
}

export interface SessionShareStartInput {
  sessionId: string;
  title: string;
  transport: PortForwardTransport;
  snapshot: string;
  cols: number;
  rows: number;
  terminalAppearance: SessionShareTerminalAppearance;
  viewportPx: SessionShareViewportPx | null;
}

export interface SessionShareSnapshotInput {
  sessionId: string;
  snapshot: string;
  cols: number;
  rows: number;
  kind: SessionShareSnapshotKind;
  terminalAppearance: SessionShareTerminalAppearance;
  viewportPx: SessionShareViewportPx | null;
}

export interface SessionShareInputToggleInput {
  sessionId: string;
  inputEnabled: boolean;
}

export interface SessionShareEvent {
  sessionId: string;
  state: SessionShareState;
}

export type SessionShareChatSenderRole = 'owner' | 'viewer';

export interface SessionShareChatMessage {
  id: string;
  nickname: string;
  senderRole: SessionShareChatSenderRole;
  text: string;
  sentAt: string;
}

export const SESSION_SHARE_CHAT_HISTORY_LIMIT = 50;

export interface SessionShareChatEvent {
  sessionId: string;
  message: SessionShareChatMessage;
}

export interface SessionShareOwnerChatSnapshot {
  sessionId: string;
  title: string;
  ownerNickname: string;
  state: SessionShareState;
  messages: SessionShareChatMessage[];
}

export type SessionShareControlSignal = 'interrupt' | 'suspend' | 'quit';

export type SessionShareOwnerMessage =
  | {
      type: 'hello';
      title: string;
      hostLabel: string;
      transport: PortForwardTransport;
      cols: number;
      rows: number;
      snapshot: string;
      terminalAppearance: SessionShareTerminalAppearance;
      viewportPx: SessionShareViewportPx | null;
    }
  | {
      type: 'output';
      data: string;
    }
  | {
      type: 'resize';
      cols: number;
      rows: number;
      terminalAppearance: SessionShareTerminalAppearance;
      viewportPx: SessionShareViewportPx | null;
    }
  | {
      type: 'snapshot';
      snapshot: string;
      cols: number;
      rows: number;
      snapshotKind: SessionShareSnapshotKind;
      terminalAppearance: SessionShareTerminalAppearance;
      viewportPx: SessionShareViewportPx | null;
    }
  | {
      type: 'input-enabled';
      inputEnabled: boolean;
    }
  | {
      type: 'chat-send';
      text: string;
    }
  | {
      type: 'chat-message';
      message: SessionShareChatMessage;
    }
  | {
      type: 'session-ended';
    };

export type SessionShareViewerMessage =
  | {
      type: 'init';
      title: string;
      hostLabel: string;
      transport: PortForwardTransport;
      cols: number;
      rows: number;
      inputEnabled: boolean;
      viewerCount: number;
      terminalAppearance: SessionShareTerminalAppearance;
      viewportPx: SessionShareViewportPx | null;
    }
  | {
      type: 'snapshot-init';
      snapshot: string;
      cols: number;
      rows: number;
      terminalAppearance: SessionShareTerminalAppearance;
      viewportPx: SessionShareViewportPx | null;
    }
  | {
      type: 'snapshot-resync';
      snapshot: string;
      cols: number;
      rows: number;
      terminalAppearance: SessionShareTerminalAppearance;
      viewportPx: SessionShareViewportPx | null;
    }
  | {
      type: 'replay';
      entries: string[];
    }
  | {
      type: 'output';
      data: string;
    }
  | {
      type: 'chat-history';
      messages: SessionShareChatMessage[];
    }
  | {
      type: 'chat-message';
      message: SessionShareChatMessage;
    }
  | {
      type: 'resize';
      cols: number;
      rows: number;
      terminalAppearance: SessionShareTerminalAppearance;
      viewportPx: SessionShareViewportPx | null;
    }
  | {
      type: 'input-enabled';
      inputEnabled: boolean;
    }
  | {
      type: 'viewer-count';
      viewerCount: number;
    }
  | {
      type: 'share-ended';
      message: string;
    };

export type SessionShareViewerClientMessage =
  | {
      type: 'input';
      encoding: 'utf8' | 'binary';
      data: string;
    }
  | {
      type: 'control-signal';
      signal: SessionShareControlSignal;
    }
  | {
      type: 'chat-profile';
      nickname: string;
    }
  | {
      type: 'chat-send';
      text: string;
    };

export interface TerminalConnectionProgress {
  stage: TerminalConnectionStage;
  message: string;
  blockingKind: TerminalConnectionBlockingKind;
  retryable: boolean;
}

// TerminalReconnectState는 자동 재연결 진행 상황을 UI에 표시하기 위한 요약이다.
// 휘발성 타이머/시크릿 등은 store 밖 오케스트레이터가 보유하고, 여기엔 표시용 값만 둔다.
export interface TerminalReconnectState {
  attempt: number;
  maxAttempts: number;
  /** 다음 시도 예정 시각(epoch ms). 네트워크 대기 중이면 0. */
  nextAttemptAt: number;
  waitingForNetwork: boolean;
}

// TerminalTmuxPaneState는 control mode(tmux -CC) pane일 때만 채워진다.
// 하나의 control 채널 위에 여러 pane이 가상 sessionId로 얹히므로, 이 탭의 입력은
// 프록시를 통해 controlSessionId의 control 채널로 send-keys 되고, 출력은 paneId
// 기반 가상 sessionId의 stream으로 들어온다.
export interface TerminalTmuxPaneState {
  /** 이 pane이 얹힌 control 채널(tmux -CC) 세션 id. */
  controlSessionId: string;
  /** tmux pane id (예: "%3"). */
  paneId: string;
  /** tmux window id (예: "@1"). window→탭 매핑에 쓴다. */
  windowId: string;
}

/** SSH 접속 후 보조채널로 감지한 원격 tmux 정보(하단바 표시용). */
export interface TerminalTmuxAvailable {
  version: string;
  sessions: TerminalTmuxSessionInfo[];
}

export interface TerminalTmuxSessionInfo {
  name: string;
  windows: number;
  attached: boolean;
}

/** 다단 ProxyJump 연결 진행: 각 홉(점프/최종 대상)의 상태. index는 1-based(첫 홉 … count=최종 대상). */
export interface TerminalConnectionHop {
  index: number;
  count: number;
  label: string;
  stage: 'connecting' | 'connected' | 'failed';
  /** 사용자가 붙인 호스트 이름(선택). Go 라벨(user@host:port) 위에 얹어 표시. renderer가 채운다. */
  name?: string | null;
}

export interface TerminalTab {
  id: string;
  /**
   * 탭 최초 생성 시 1회 발급되어 재연결/재시도로 sessionId가 바뀌어도 불변인 식별자.
   * 자동 재연결 오케스트레이터의 key, 터미널 인스턴스(스크롤백) 보존, pane key에 쓰인다.
   */
  stableId: string;
  sessionId: string;
  source: TerminalSessionSource;
  hostId: string | null;
  title: string;
  shellKind?: string;
  status: 'pending' | 'connecting' | 'connected' | 'disconnecting' | 'closed' | 'error';
  errorMessage?: string;
  connectionProgress?: TerminalConnectionProgress | null;
  /** 다단 ProxyJump 연결 중 각 홉의 상태(연결 화면 표시용). 새 연결 시도 시 리셋, 비었으면 미표시. */
  connectionHops?: TerminalConnectionHop[] | null;
  /** 자동 재연결 진행 중일 때만 채워지는 표시용 상태. 평시엔 null/undefined. */
  reconnect?: TerminalReconnectState | null;
  sessionShare?: SessionShareState | null;
  hasReceivedOutput?: boolean;
  /** mosh 세션의 연결 상태(하단 상태바 표시용). mosh가 아니면 null/undefined. */
  moshState?: 'connected' | 'reconnecting' | 'disconnected' | null;
  /** 마지막으로 mosh 서버 응답을 받은 시각(RFC3339). "N초 전 응답" 표시에 쓴다. */
  lastMoshResponseAt?: string | null;
  /** keepalive round-trip(ms). 탭 인디게이터가 활성 탭에 RTT 표시. keepalive 주기마다 갱신. */
  lastRttMs?: number | null;
  /**
   * 셸 통합(OSC 133) 기반 직전 명령 상태: 실행 중 / 성공(exit 0) / 실패(exit≠0).
   * 탭 상태 점이 연결이 정상일 때 이 값을 보여준다(하이브리드). 셸 통합 없으면 null/undefined.
   */
  commandState?: 'running' | 'ok' | 'failed' | null;
  /**
   * 이 탭이 터미널이 아니라 원격 화면이면 'rdp'·'vnc'. 없거나 'terminal' 이면 터미널이다.
   * 원격 화면 세션은 재연결·tmux·셸 통합 같은 터미널 기계를 타지 않으므로 렌더링 분기에 쓴다.
   */
  paneKind?: 'terminal' | 'rdp' | 'vnc';
  /**
   * RDP 세션이 쓰고 있는 원격 모니터 수. 접속 응답에서 채운다.
   *
   * 전체화면에서 화면마다 창을 펼칠지 정하는 데 쓴다 — 1이면 펼칠 것이 없다.
   */
  rdpMonitorCount?: number;
  /**
   * 탭 hover 의 대상 표기(user@host)용 계정. RDP 는 계정이 호스트가 아니라 자격증명에
   * 있어 렌더러가 모르므로, 접속 응답에 실려 온 것을 보관한다. 도메인이 있으면
   * `DOMAIN\user` 형태다.
   */
  rdpUsername?: string;
  /** 원격 데스크톱의 현재 해상도. 접속 응답에서 채우고 resized 이벤트로 갱신한다. */
  rdpDesktopSize?: { width: number; height: number };
  /** control mode(tmux -CC) pane일 때만 채워진다. 평시엔 null/undefined. */
  tmux?: TerminalTmuxPaneState | null;
  /** SSH 접속 후 감지한 원격 tmux 정보(하단바 표시용). 미감지면 null/undefined. */
  tmuxAvailable?: TerminalTmuxAvailable | null;
  lastEventAt: string;
}
