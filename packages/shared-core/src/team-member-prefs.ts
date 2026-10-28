import type { AuthType, HostRecord, KnownHostRecord, ManagedAwsProfilePayload } from "./models";

/*
 * 팀 볼트에서 사람마다 다른 값 — 멤버 개인 칸의 모양과, 팀 레코드에서 그 값을 빼는 규칙.
 *
 * 멤버 개인 칸은 팀 볼트 안에 레코드 단위로 두고 내 개인 DEK 로 잠근다. 나만 보고 내 기기끼리 맞춰진다 — 그래서
 * 데스크톱과 모바일이 같은 모양으로 읽어야 한다. 모양과 정규화는 이 파일 하나다.
 */

/**
 * 팀 호스트에 쓰는 내 자격 증명(멤버 개인 칸). 비운 칸은 호스트 것을 쓴다 — 사용자 이름을 비우면 호스트의
 * 사용자 이름, 인증 방식을 비우면 호스트의 인증 방식이다. 접속할 때 내 것 → 팀 것 → 요청 창 순으로 찾는다.
 */
export interface TeamHostCredentials {
  username?: string;
  authType?: AuthType;
  password?: string;
  passphrase?: string;
  privateKeyPem?: string;
  certificateText?: string;
  /** RDP 계정의 도메인. */
  domain?: string;
  /** 키 파일 경로는 그 기기의 파일이라 늘 내 칸에 둔다(키는 privateKeyPem 에 들어 있다). */
  privateKeyPath?: string;
  certificatePath?: string;
}

const AUTH_TYPES: readonly AuthType[] = ["password", "privateKey", "keyboardInteractive", "certificate", "agent"];
const CREDENTIAL_TEXT_FIELDS = [
  "username",
  "password",
  "passphrase",
  "privateKeyPem",
  "certificateText",
  "domain",
  "privateKeyPath",
  "certificatePath",
] as const;

/** 저장·전송된 값을 자격 증명으로. 아는 칸의 비어 있지 않은 글만 남긴다. 남는 것이 없으면 null. */
export function normalizeTeamHostCredentials(value: unknown): TeamHostCredentials | null {
  if (!isRecord(value)) {
    return null;
  }
  const credentials: TeamHostCredentials = {};
  for (const field of CREDENTIAL_TEXT_FIELDS) {
    const text = value[field];
    if (typeof text === "string" && text.length > 0) {
      credentials[field] = text;
    }
  }
  if (typeof value.authType === "string" && (AUTH_TYPES as readonly string[]).includes(value.authType)) {
    credentials.authType = value.authType as AuthType;
  }
  return Object.keys(credentials).length > 0 ? credentials : null;
}

/** 비밀값(비밀번호·키·인증서·패스프레이즈)이 하나라도 있다. 사용자 이름만 둔 것과 가른다. */
export function hasCredentialSecret(credentials: TeamHostCredentials): boolean {
  return Boolean(
    credentials.password || credentials.passphrase || credentials.privateKeyPem || credentials.certificateText,
  );
}

/**
 * 팀 호스트에 대한 내 설정(멤버 개인 칸). 사람마다 다른 값이라 팀 레코드에는 넣지 않고, 내 개인 DEK 로 잠가 내
 * 기기끼리만 맞춘다. 테마는 여기도 아니고 그 기기에만 둔다.
 */
export interface TeamHostPrefsRecord {
  /** 호스트 ID. */
  id: string;
  favorite: boolean | null;
  agentForwarding: boolean | null;
  /**
   * 내가 이 RDP 호스트에서 신뢰한 서버 인증서 지문. 팀 레코드에 쓰지 못해(읽기 전용·모바일) 내 칸에 두고, 화면과
   * 접속에는 팀 것 대신 이것을 쓴다.
   */
  rdpCertificateFingerprint: string | null;
  /** 내가 이 호스트로 접속하며 신뢰한 호스트 키 — 위와 같은 까닭으로 내 칸에 둔다. 찾을 때 팀 것보다 먼저다. */
  knownHosts: KnownHostRecord[];
  updatedAt: string;
}

/** 팀 워크스페이스에 대한 내 설정(멤버 개인 칸). */
export interface TeamWorkspacePrefsRecord {
  /** 워크스페이스 ID. */
  id: string;
  favorite: boolean;
  lastOpenedAt: string | null;
  updatedAt: string;
}

export function normalizeTeamHostPrefsRecord(value: unknown): TeamHostPrefsRecord | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.updatedAt !== "string") {
    return null;
  }
  return {
    id: value.id,
    favorite: value.favorite === true ? true : null,
    agentForwarding: value.agentForwarding === true ? true : null,
    rdpCertificateFingerprint:
      typeof value.rdpCertificateFingerprint === "string" && value.rdpCertificateFingerprint
        ? value.rdpCertificateFingerprint
        : null,
    knownHosts: Array.isArray(value.knownHosts)
      ? value.knownHosts.map(normalizeKnownHostRecord).filter((entry): entry is KnownHostRecord => entry !== null)
      : [],
    updatedAt: value.updatedAt,
  };
}

/** 호스트 키 기록 하나(내 칸에서 읽을 때). 빠진 칸이 있으면 버린다 — 접속 판단에 쓰는 값이다. */
function normalizeKnownHostRecord(value: unknown): KnownHostRecord | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.host !== "string" ||
    typeof value.port !== "number" ||
    typeof value.algorithm !== "string" ||
    typeof value.publicKeyBase64 !== "string" ||
    typeof value.fingerprintSha256 !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    ...(typeof value.tailnetId === "string" && value.tailnetId ? { tailnetId: value.tailnetId } : {}),
    host: value.host,
    port: value.port,
    algorithm: value.algorithm,
    publicKeyBase64: value.publicKeyBase64,
    fingerprintSha256: value.fingerprintSha256,
    createdAt: value.createdAt,
    lastSeenAt: typeof value.lastSeenAt === "string" ? value.lastSeenAt : value.updatedAt,
    updatedAt: value.updatedAt,
  };
}

export function normalizeTeamWorkspacePrefsRecord(value: unknown): TeamWorkspacePrefsRecord | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.updatedAt !== "string") {
    return null;
  }
  return {
    id: value.id,
    favorite: value.favorite === true,
    lastOpenedAt: typeof value.lastOpenedAt === "string" ? value.lastOpenedAt : null,
    updatedAt: value.updatedAt,
  };
}

/**
 * 팀 레코드에서 사람마다 다른 값(즐겨찾기·테마·agent forwarding)을 뺀다. 팀 레코드에 넣으면 내 값이 팀원 모두에게
 * 가므로 올리기·받기 때 빼고, 읽어 돌려줄 때 내 칸의 값을 얹는다.
 */
export function stripHostMemberPrefs(host: HostRecord): HostRecord {
  // agent forwarding 은 SSH 로 붙는 호스트에만 있는 칸이다.
  if (host.kind === "ssh" || host.kind === "aws-ec2") {
    return { ...host, favorite: null, terminalThemeId: null, agentForwarding: null };
  }
  return { ...host, favorite: null, terminalThemeId: null };
}

/**
 * 정적 AWS 프로필의 키를 뺀다. 키는 사람의 인증 정보라(IAM 키로 한 일은 그 키 주인으로 남는다) 팀에 올리지 않고,
 * 넣은 기기에만 있다 — 올릴 때 빼고, 받을 때도 옛 앱이 섞어 올린 것을 담지 않는다.
 */
export function stripAwsProfileKeys(payload: ManagedAwsProfilePayload): ManagedAwsProfilePayload {
  return payload.kind === "static" ? { ...payload, accessKeyId: "", secretAccessKey: "" } : payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
