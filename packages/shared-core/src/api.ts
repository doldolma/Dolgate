// 인증 API가 반환하는 토큰 쌍이다.
export interface AuthTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

// 데스크톱이 로그인 후 세션에 올려둘 최소 사용자 정보다.
export interface SessionUser {
  id: string;
  email: string;
}

// 동기화 암호 → KEK 유도 파라미터. 서버는 보관·배포만 하고 해석하지 않는다.
export interface VaultKdfDescriptor {
  algorithm: string;
  saltBase64: string;
  memoryKib: number;
  timeCost: number;
  parallelism: number;
}

// 서버가 세션 발급 시 돌려주는 vault descriptor 다.
// version 0: 볼트 없음(신규 유저) — 클라이언트가 동기화 암호 설정 플로우를 시작한다.
// version 1: 레거시 — 서버 보관 DEK 원문(keyBase64)을 그대로 내려준다.
// version 2: E2EE — 동기화 암호로 감싼 DEK(wrappedDekBase64)만 내려준다. 서버는 복호화 불가.
// version 이 없는 응답은 v2 도입 이전 서버 — v1 로 취급한다.
export interface VaultBootstrap {
  version?: number;
  keyBase64?: string;
  wrappedDekBase64?: string;
  // 계정은 이미 v2 floor인데 과거 배포에서 v1 행이 남은 복구 상태. 이 경우 v1 키로
  // 동기화하지 않고 즉시 E2EE 마이그레이션을 완료해야 한다.
  e2eeRequired?: boolean;
  // DEK 세대 번호(단조 증가). 초기화(reset)와 재설정이 각각 +1, 암호 변경(rewrap)은 유지.
  // 캐시한 epoch 과 크기 비교해 "낡은 descriptor 무시 / DEK 세대 교체 감지"를 순서 있게
  // 판별하고, push 시 fence 헤더로 보낸다. epoch 도입 이전 서버 응답에는 없다(0 취급).
  epoch?: number;
  // 같은 DEK 세대 안에서 wrapped DEK/KDF가 갱신된 순서다. 신규 v2는 1부터 시작하고,
  // 필드 도입 이전 v2 행/서버는 0으로 취급한다. rewrap만 +1 한다.
  wrapRevision?: number;
  // DEK 공개 검증자(HMAC-SHA256(key=DEK, msg=고정라벨), base64). 캐시한 DEK 로 같은 값을
  // 계산해 일치하면 그 DEK 가 이 볼트의 DEK 임이 증명된다. 도입 이전 볼트/서버에는 없다.
  dekVerifierBase64?: string;
  kdf?: VaultKdfDescriptor | null;
}

// POST/PUT /auth/vault 응답 — 방금 시작/유지된 DEK 세대(epoch)를 돌려준다.
export interface VaultMutationResponse {
  epoch?: number;
  wrapRevision?: number;
}

export interface OfflineLease {
  token: string;
  issuedAt: string;
  expiresAt: string;
  verificationPublicKeyPem: string;
}

// 로그인/교환/refresh 성공 시 desktop이 한 번에 받아야 하는 세션 정보다.
export interface AuthSession {
  user: SessionUser;
  tokens: AuthTokenPair;
  vaultBootstrap: VaultBootstrap;
  offlineLease: OfflineLease;
  syncServerTime: string;
}

// 브라우저 로그인 완료 후 desktop이 one-time code를 교환할 때 쓰는 본문이다.
export interface BrowserAuthExchangeRequest {
  code: string;
}

export type SyncKind =
  | 'groups'
  | 'hosts'
  | 'secrets'
  | 'knownHosts'
  | 'portForwards'
  | 'dnsOverrides'
  | 'preferences'
  | 'awsProfiles'
  | 'snippets';

// 서버는 payload를 해석하지 않고 암호문 그대로 저장한다.
export interface SyncRecord {
  id: string;
  encrypted_payload: string;
  updated_at: string;
  deleted_at?: string | null;
}

// 동기화 조회/업서트 응답 본문.
export interface SyncPayloadV2 {
  groups: SyncRecord[];
  hosts: SyncRecord[];
  secrets: SyncRecord[];
  knownHosts: SyncRecord[];
  portForwards: SyncRecord[];
  dnsOverrides: SyncRecord[];
  preferences: SyncRecord[];
  awsProfiles: SyncRecord[];
  snippets: SyncRecord[];
}

export interface ServerInfoResponse {
  serverVersion: string;
  capabilities: {
    sync: {
      awsProfiles: boolean;
    };
    sessions: {
      awsSsm: boolean;
      awsSftp?: boolean;
      awsSsoBrowserFlow?: boolean;
    };
    // v2 도입 이전 서버 응답에는 없다.
    vault?: {
      e2ee: boolean;
    };
  };
}

export interface AwsSftpHostKeyInfo {
  host: string;
  port: number;
  remoteIp?: string | null;
  algorithm: string;
  fingerprintSha256: string;
  keyBase64: string;
}

export interface AwsSftpCreateSessionRequest {
  hostId: string;
  label: string;
  profileName: string;
  region: string;
  instanceId: string;
  availabilityZone: string;
  sshUsername: string;
  sshPort: number;
  env: Record<string, string>;
  unsetEnv?: string[];
  trustedHostKeyBase64?: string | null;
  trustedHostKeysBase64?: string[] | null;
}

export interface AwsSftpSessionResponse {
  sessionId: string;
  path: string;
  connectedAt: string;
}

export interface AwsSftpHostKeyChallengeResponse {
  code: 'host_key_required' | 'host_key_mismatch';
  message: string;
  info: AwsSftpHostKeyInfo;
}

export interface AwsSftpDirectoryListResponse {
  path: string;
  entries: Array<{
    name: string;
    path: string;
    isDirectory: boolean;
    size: number;
    mtime: string;
    kind: 'folder' | 'file' | 'symlink' | 'unknown';
    permissions?: string;
  }>;
}

export interface AwsSftpReadChunkRequest {
  path: string;
  offset: number;
  length: number;
}

export interface AwsSftpReadChunkResponse {
  bytesBase64: string;
  bytesRead: number;
  eof: boolean;
}

export interface AwsSftpWriteChunkRequest {
  path: string;
  offset: number;
  bytesBase64: string;
}

export interface AwsTemporaryCredentialPayload {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAt?: string | null;
}

export interface AwsSsoMobileLoginStartRequest {
  targetProfileName: string;
  sourceProfileName: string;
  sourceProfileFingerprint: string;
  ssoStartUrl: string;
  ssoRegion: string;
  ssoAccountId: string;
  ssoRoleName: string;
  redirectUri: string;
}

export interface AwsSsoMobileLoginHandoffRequest {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

export type AwsSsoLoginState =
  | "pending"
  | "ready"
  | "cancelled"
  | "expired"
  | "error";

export interface AwsSsoMobileLoginStartResponse {
  loginId: string;
  status: AwsSsoLoginState;
  browserUrl?: string | null;
  expiresAt?: string | null;
  message?: string | null;
  credential?: AwsTemporaryCredentialPayload | null;
}

export interface AwsSsoMobileHandoffResponse {
  loginId: string;
  status: AwsSsoLoginState;
  expiresAt?: string | null;
  message?: string | null;
  credential?: AwsTemporaryCredentialPayload | null;
}
