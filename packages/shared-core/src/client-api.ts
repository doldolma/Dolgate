import type {
  AppLanguage,
  AppTheme,
  AuthState,
  HostEnvVar,
  HostRecord,
  KnownHostRecord,
  LoadedManagedSecretPayload,
  DirectoryListing,
  SessionConnectionKind,
  SecretMetadataRecord,
  SshHostRecord,
  SyncStatus,
  TerminalTab,
} from "./models";

export interface HostSecretInput {
  /** 이 자격증명이 어느 프로토콜용인가. 없으면 SSH 로 본다. */
  kind?: 'ssh' | 'rdp' | 'vnc';
  /**
   * 이 자격증명의 계정. RDP 는 계정이 자격증명에 딸린다([[SecretMetadataRecord]] 참고).
   *
   * 이것만 있고 비밀번호가 없으면 자격증명을 만들지 않는다 — 비밀이 없는 자격증명은 의미가 없다.
   */
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
}

export interface ClientSessionEvent {
  type: "connected" | "closed" | "error";
  sessionId: string;
  message?: string | null;
}

export interface MobileAuthRedirectPayload {
  code: string;
  state?: string | null;
}

export interface MobileSettings {
  serverUrl: string;
  theme: AppTheme;
  /** UI 언어. 생략/undefined 는 'system'(기기 언어 따르기). */
  language?: AppLanguage;
  /**
   * 세션을 보고 있는 동안 화면이 꺼지지 않게 잡아 둔다. 생략/undefined 는 켜짐.
   *
   * 명령이 끝나기를 기다리며 터미널을 보는 것이 이 앱의 주 용도라 기본은 켜 둔다. 다만 기기의
   * 자동 꺼짐 설정을 앱이 덮는 것이므로, 그것을 원하지 않는 사용자가 끌 수 있어야 한다.
   */
  keepScreenAwake?: boolean;
  /**
   * 터미널 명령 자동완성. 생략 시 켜짐.
   *
   * **셸 통합까지 함께 정한다.** 자동완성이 쓰는 재료(명령 단위·현재 경로·종료 코드)가 곧
   * OSC 133/7 훅이 만드는 것이라, 끄면 엔진이 이 기기의 셸에 아무것도 타이핑하지 않는다 —
   * 서브셸 재주입도 여기에 딸린다. 데스크톱은 두 스위치를 따로 두지만(AppSettings), 모바일은
   * 하나로 묶었다: 좁은 설정 화면에서 "자동완성은 껐는데 셸에는 여전히 뭔가 들어간다"는
   * 상태를 설명할 자리가 없다.
   *
   * 세션이 열릴 때 정해지므로 바꾼 값은 다음 연결부터 적용된다.
   */
  terminalAutocompleteEnabled?: boolean;
  /** 기본 서브셸 명령 패턴에 추가할 사용자 정의 정규식. */
  subshellReinjectPatterns?: string[];
}

export interface MobileSessionRecord {
  id: string;
  sessionId: string;
  hostId: string;
  title: string;
  status: TerminalTab["status"];
  connectionKind?: SessionConnectionKind;
  connectionDetails?: string | null;
  /** Ephemeral connection progress shown while the session is opening. */
  connectionStatusMessage?: string | null;
  hasReceivedOutput: boolean;
  isRestorable: boolean;
  lastViewportSnapshot: string;
  /**
   * 탭이 열린 시각. 정렬 기준으로만 쓰며 한 번 정해지면 바뀌지 않는다 — lastEventAt 은
   * 활동마다 갱신돼서 탭 순서 기준으로 쓸 수 없다. 이 필드가 없던 버전에서 저장된
   * 레코드는 undefined 다(콜드 스타트가 세션을 모두 닫으므로 탭에는 나타나지 않는다).
   */
  openedAt?: string;
  lastEventAt: string;
  lastConnectedAt?: string | null;
  lastDisconnectedAt?: string | null;
  errorMessage?: string | null;
  /**
   * 이 세션이 왜 끊겼는지. 'dropped' 는 사용자가 끊은 것이 아니라 밖에서 끊긴 것이다 —
   * iOS 가 백그라운드에서 프로세스를 정지시킨 경우, 네트워크가 사라진 경우, 앱이 재시작된
   * 경우. 상태는 'error' 로 두어 탭이 남지만(isLiveSession 은 'closed' 만 제외한다) 표시와
   * 취급을 진짜 오류와 구분해야 해서 이유를 따로 남긴다:
   *
   * - 탭 라벨을 "Disconnected"(중립)로 — 앱 전환 한 번에 "Error" 는 과하다
   * - **자동 재연결을 이 값에만 적용한다.** 비밀번호 오류·호스트키 불일치 같은 진짜 실패를
   *   포그라운드 복귀마다 무한히 재시도하지 않으려면 이 구분이 필요하다
   *
   * 상태 유니온(TerminalTab["status"])에 값을 더하지 않은 이유는 그것이 데스크톱과 공유되기
   * 때문이다. 이 필드는 MobileSessionRecord 에만 있어 데스크톱에 파급이 없다.
   */
  disconnectReason?: "dropped";
}

export type MobileConnectionTabRef =
  | {
      kind: "terminal";
      id: string;
    }
  | {
      kind: "sftp";
      id: string;
    }
  | {
      kind: "rdp";
      id: string;
    }
  | {
      kind: "vnc";
      id: string;
    };

// ---------------------------------------------------------------------------
// Remote Desktop (RDP/VNC) Mobile Session Types
// ---------------------------------------------------------------------------

/** The protocol used for a remote desktop session. */
export type RemoteDesktopProtocol = "rdp" | "vnc";

/**
 * Status lifecycle for a mobile remote desktop session. Mirrors terminal session
 * states but avoids coupling to TerminalTab["status"].
 */
export type MobileRemoteDesktopSessionStatus =
  | "connecting"
  | "connected"
  | "disconnecting"
  | "error"
  | "closed";

/**
 * Input mode for the remote desktop surface. Controls how touch events are
 * interpreted by the native layer.
 */
export type RemoteDesktopInputMode = "touch" | "trackpad" | "none";

/**
 * Scale mode for the remote desktop surface.
 */
export type RemoteDesktopScaleMode = "fit" | "fill" | "native";

/**
 * Session record for a mobile remote desktop connection. Kept separate from
 * MobileSessionRecord to avoid terminal-specific fields leaking in (viewport
 * snapshot, hasReceivedOutput, isRestorable, etc.).
 */
export interface MobileRemoteDesktopSessionRecord {
  id: string;
  hostId: string;
  protocol: RemoteDesktopProtocol;
  title: string;
  status: MobileRemoteDesktopSessionStatus;
  /** Current input mode. Native layer interprets touch according to this. */
  inputMode: RemoteDesktopInputMode;
  /** Current scale mode for the framebuffer display. */
  scaleMode: RemoteDesktopScaleMode;
  /** Native framebuffer metadata; pixel bytes remain native-only. */
  desktopWidth?: number | null;
  desktopHeight?: number | null;
  desktopName?: string | null;
  /** Ephemeral connection progress shown while the session is opening. */
  connectionStatusMessage?: string | null;
  errorMessage?: string | null;
  /** Tab ordering — same basis as terminal/sftp openedAt. */
  openedAt?: string;
  lastEventAt: string;
  lastConnectedAt?: string | null;
  lastDisconnectedAt?: string | null;
}

export type MobileSftpSessionStatus =
  | "connecting"
  | "connected"
  | "error"
  | "disconnecting"
  | "closed";

export interface MobileSftpSessionRecord {
  id: string;
  hostId: string;
  /**
   * 이 SFTP 탭을 띄운 터미널 세션(있을 때만). SFTP 는 자기 연결을 따로 열기 때문에 전송
   * 통로가 아니라 어디서 열렸는지만 남기는 역참조다 — 호스트에서 바로 연 경우에는 없다.
   */
  sourceSessionId?: string | null;
  title: string;
  status: MobileSftpSessionStatus;
  currentPath: string;
  listing?: DirectoryListing | null;
  /** Ephemeral connection progress shown while the SFTP session is opening. */
  connectionStatusMessage?: string | null;
  errorMessage?: string | null;
  /** 터미널 탭과 같은 기준으로 섞어 정렬하기 위한 값. MobileSessionRecord.openedAt 참고. */
  openedAt?: string;
  lastEventAt: string;
  lastConnectedAt?: string | null;
  lastDisconnectedAt?: string | null;
}

export type MobileSftpTransferDirection = "download" | "upload" | "copy";
export type MobileSftpTransferStatus =
  | "pending"
  | "running"
  | "completed"
  | "error";

export interface MobileSftpTransferRecord {
  id: string;
  sftpSessionId: string;
  direction: MobileSftpTransferDirection;
  remotePath: string;
  localName: string;
  status: MobileSftpTransferStatus;
  bytesTransferred: number;
  totalBytes?: number | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientSshConnectInput {
  host: SshHostRecord;
  cols: number;
  rows: number;
  title?: string;
  secrets?: HostSecretInput;
}

export interface AwsSessionEnvSpec {
  env: Record<string, string>;
  unsetEnv: string[];
}

export interface ResolvedAwsConnectPayload {
  profileName: string;
  region: string;
  instanceId: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  unsetEnv?: string[];
  /**
   * In-process SSM data channel: when streamUrl/tokenValue are set (issued via
   * ssm:StartSession in the main process), ssh-core opens the SSM WebSocket
   * itself instead of spawning aws + session-manager-plugin.
   */
  streamUrl?: string;
  tokenValue?: string;
  ssmSessionId?: string;
  /**
   * KMS 세션 암호화 자료.
   *
   * 계정의 Session Manager 설정에서 세션 암호화를 켜 두면 에이전트가 handshake 에서 이것을
   * 요구하고, 못 내놓으면 세션이 취소된다(협상 불가). ssh-core 는 AWS 자격증명을 갖지 않으므로
   * 데이터 키는 자격증명을 가진 쪽이 kms:GenerateDataKey 로 만들어 넘긴다 — 세션 토큰과 같은
   * 방식이고, 평문 키도 같은 등급의 값이다.
   */
  kmsKeyId?: string;
  kmsCipherTextBlobBase64?: string;
  kmsPlainTextKeyBase64?: string;
  /**
   * SSM 세션이 떨어지는 셸의 종류. Windows 인스턴스는 'powershell' 이고, 비어 있으면
   * POSIX 셸(리눅스에서 SSM 이 열어 주는 것)이다.
   *
   * 코어가 셸 통합 스크립트를 타이핑해도 되는지 판단하는 데 쓴다 — POSIX 스크립트라
   * PowerShell 에서는 파싱 오류만 화면에 쏟는다.
   */
  shellKind?: string;
}

export interface AwsSsmSessionStartRequest extends ResolvedAwsConnectPayload {
  hostId: string;
  label: string;
}

export type AwsSsmSessionClientMessage =
  | {
      type: "start";
      payload: AwsSsmSessionStartRequest;
    }
  | {
      type: "input";
      dataBase64: string;
    }
  | {
      type: "resize";
      cols: number;
      rows: number;
    }
  | {
      type: "close";
    };

export type AwsSsmSessionServerMessage =
  | {
      type: "ready";
    }
  | {
      type: "output";
      dataBase64: string;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "exit";
      message?: string | null;
    };

export interface ClientApi {
  auth: {
    getState: () => Promise<AuthState>;
    beginBrowserLogin: () => Promise<void>;
    completeBrowserLogin: (
      payload: MobileAuthRedirectPayload,
    ) => Promise<AuthState>;
    refresh: () => Promise<AuthState>;
    logout: () => Promise<void>;
  };
  sync: {
    bootstrap: () => Promise<SyncStatus>;
    pushKnownHosts: (records: KnownHostRecord[]) => Promise<SyncStatus>;
    status: () => Promise<SyncStatus>;
  };
  hosts: {
    list: () => Promise<HostRecord[]>;
  };
  knownHosts: {
    list: () => Promise<KnownHostRecord[]>;
  };
  secrets: {
    list: () => Promise<SecretMetadataRecord[]>;
    load: (secretRef: string) => Promise<LoadedManagedSecretPayload | null>;
  };
  settings: {
    get: () => Promise<MobileSettings>;
    update: (input: Partial<MobileSettings>) => Promise<MobileSettings>;
  };
  sessions: {
    list: () => Promise<MobileSessionRecord[]>;
    connect: (input: ClientSshConnectInput) => Promise<{ sessionId: string }>;
    write: (sessionId: string, data: string) => Promise<void>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
    disconnect: (sessionId: string) => Promise<void>;
    onEvent: (listener: (event: ClientSessionEvent) => void) => () => void;
    onData: (
      sessionId: string,
      listener: (chunk: Uint8Array) => void,
    ) => () => void;
  };
}
