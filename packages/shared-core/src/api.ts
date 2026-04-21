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

// 서버가 로그인 성공 시 돌려주는 vault bootstrap 재료다.
// 지금 버전에서는 서버가 관리하는 대칭키를 그대로 세션에 주입한다.
export interface VaultBootstrap {
  keyBase64: string;
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
  | 'awsProfiles';

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
}

export interface ServerInfoResponse {
  serverVersion: string;
  capabilities: {
    sync: {
      awsProfiles: boolean;
    };
    sessions: {
      awsSsm: boolean;
      awsSsoBrowserFlow?: boolean;
    };
  };
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
