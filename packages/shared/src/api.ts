// 인증 API가 반환하는 토큰 쌍이다.
export interface AuthTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

// 로그인/회원가입 성공 시 반환하는 응답 구조다.
export interface AuthResponse {
  userId: string;
  email: string;
  tokens: AuthTokenPair;
}

// 서버는 payload를 해석하지 않고 암호문 그대로 저장한다.
export interface SyncRecord {
  id: string;
  encrypted_payload: string;
  updated_at: string;
  deleted_at?: string | null;
}

// 동기화 조회 응답.
export interface SyncResponse {
  hosts: SyncRecord[];
  snippets: SyncRecord[];
}

// 동기화 업서트 요청 본문.
export interface SyncUpsertRequest {
  hosts: SyncRecord[];
  snippets: SyncRecord[];
}
