import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base64ToBytes, bytesToBase64 } from "./base64";

// 팀 볼트의 클라이언트측 암호학.
//
// 팀 키(팀 DEK)는 팀마다 하나이고 바뀌지 않는다. 멤버마다 자기 개인 DEK 로 감싼 사본을 서버에 두고,
// 새 멤버는 초대 링크의 상자에서 꺼낸다 — 공개키 암호가 필요 없다.
//
//   사본      = AES-256-GCM(개인 DEK, iv, 팀 DEK, AAD "dolgate-team-key-v1|<팀 ID>")
//               → base64(iv(12) || ciphertext(32) || tag(16))
//   링크      = https://<서버>/invite/<코드>#v1.<S>
//               S = 32B 랜덤(base64url). # 뒤는 브라우저가 서버로 보내지 않는다.
//   상자 열쇠  = HKDF-SHA256(S, info "dolgate-team-invite-box-v1")
//   참여 토큰  = base64url(HKDF-SHA256(S, info "dolgate-team-invite-join-v1"))
//               서버에는 이 문자열의 SHA-256 hex 만 올린다.
//   상자      = AES-256-GCM(상자 열쇠, iv, {"v":1,"teamId","teamDek","expiresAt"},
//               AAD "dolgate-team-invite-box-v1|<팀 ID>") → base64(iv || ciphertext || tag)
//   잠근 비밀값 = AES-256-GCM(HKDF-SHA256(팀 DEK, info "dolgate-team-invite-secret-v1|<팀 ID>"), iv,
//               {"v":1,"secret"}, AAD "dolgate-team-invite-secret-v1|<팀 ID>") → base64(iv || ciphertext || tag)
//               링크 기록에 상자와 함께 둔다 — 멤버는 링크가 살아 있는 동안 이것을 열어 링크를 다시 만든다.
//
// 상자 열쇠와 참여 토큰은 같은 S 에서 따로 뽑은 값이라, 참여 때 토큰을 보는 서버도 상자는 못 연다.
// 잠근 비밀값은 팀 키가 있어야 열리므로 서버는 S 를 모른다 — 팀 키를 가진 멤버에게는 새로 알려 주는 것이 없다.
// AAD 에 팀 ID 를 묶어, 서버가 다른 팀의 사본이나 상자를 내줘도 풀리지 않는다.
// 형식은 team-test-vectors.json 이 고정한다(Node 내장 crypto 로 따로 만든 값).

export const TEAM_DEK_BYTE_LENGTH = 32;
export const TEAM_INVITE_SECRET_BYTE_LENGTH = 32;
/** 링크 # 뒤의 형식 버전. 모르는 버전은 업데이트 안내로 거절한다. */
export const TEAM_INVITE_LINK_VERSION = "v1";

const TEAM_IV_BYTE_LENGTH = 12;
const TEAM_KEY_AAD_PREFIX = "dolgate-team-key-v1|";
const TEAM_INVITE_BOX_INFO = "dolgate-team-invite-box-v1";
const TEAM_INVITE_JOIN_INFO = "dolgate-team-invite-join-v1";
const TEAM_INVITE_BOX_AAD_PREFIX = "dolgate-team-invite-box-v1|";
const TEAM_INVITE_BOX_VERSION = 1;
const TEAM_INVITE_SECRET_PREFIX = "dolgate-team-invite-secret-v1|";
const TEAM_INVITE_SECRET_VERSION = 1;
const TEAM_INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export type TeamCryptoErrorCode =
  /** 형식이 틀렸다(잘린 링크·잘못된 base64 등). */
  | "malformed"
  /** 열쇠가 맞지 않는다 — 다른 개인 DEK, 다른 팀 ID, 다른 링크 비밀값. */
  | "wrong-key"
  /** 상자의 기한이 지났다. 서버가 지난 상자를 내줘도 앱이 거절한다. */
  | "expired"
  /** 이 빌드가 모르는 형식이다 — 앱을 업데이트해야 한다. */
  | "unsupported-version";

export class TeamCryptoError extends Error {
  constructor(
    readonly code: TeamCryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TeamCryptoError";
  }
}

export function isTeamCryptoError(error: unknown): error is TeamCryptoError {
  return error instanceof TeamCryptoError;
}

export interface TeamInviteLink {
  /** 링크가 가리키는 동기화 서버(끝의 / 없음). 다른 서버로 로그인한 앱은 이것으로 안내한다. */
  serverUrl: string;
  code: string;
  secret: Uint8Array;
}

export interface OpenedTeamInviteBox {
  teamDek: Uint8Array;
  expiresAt: string;
}

export function createTeamDek(): Uint8Array {
  return randomBytes(TEAM_DEK_BYTE_LENGTH);
}

export function createTeamInviteSecret(): Uint8Array {
  return randomBytes(TEAM_INVITE_SECRET_BYTE_LENGTH);
}

/** 팀 DEK 를 개인 DEK 로 감싼다(사본). */
export function wrapTeamDek(teamDek: Uint8Array, personalDek: Uint8Array, teamId: string): string {
  return wrapTeamDekWithIv(teamDek, personalDek, teamId, randomBytes(TEAM_IV_BYTE_LENGTH));
}

// 고정 벡터 검증용으로 iv 를 받는 변형. 제품 경로는 wrapTeamDek 를 쓴다.
export function wrapTeamDekWithIv(
  teamDek: Uint8Array,
  personalDek: Uint8Array,
  teamId: string,
  iv: Uint8Array,
): string {
  assertKey(teamDek);
  assertKey(personalDek);
  const sealed = gcm(personalDek, iv, utf8ToBytes(TEAM_KEY_AAD_PREFIX + teamId)).encrypt(teamDek);
  return bytesToBase64(concatBytes(iv, sealed));
}

/** 사본을 푼다. 다른 개인 DEK·다른 팀 ID 로 감싼 것이면 "wrong-key" 다. */
export function unwrapTeamDek(wrapped: string, personalDek: Uint8Array, teamId: string): Uint8Array {
  assertKey(personalDek);
  const [iv, sealed] = splitSealed(wrapped, "잘못된 팀 키 형식입니다.");
  const teamDek = decryptOrThrow(personalDek, iv, sealed, TEAM_KEY_AAD_PREFIX + teamId);
  if (teamDek.length !== TEAM_DEK_BYTE_LENGTH) {
    throw new TeamCryptoError("malformed", "잘못된 팀 키 형식입니다.");
  }
  return teamDek;
}

/** 링크 비밀값에서 참여 토큰을 뽑는다. 상자 열쇠와 따로 뽑은 값이다. */
export function deriveTeamInviteJoinToken(secret: Uint8Array): string {
  return bytesToBase64Url(deriveInviteKey(secret, TEAM_INVITE_JOIN_INFO));
}

/** 서버에 올리고 서버가 대조하는 모양(참여 토큰 문자열의 SHA-256, 소문자 hex 64자). */
export function hashTeamInviteJoinToken(token: string): string {
  return bytesToHex(sha256(utf8ToBytes(token)));
}

export function sealTeamInviteBox(input: {
  secret: Uint8Array;
  teamId: string;
  teamDek: Uint8Array;
  expiresAt: string;
}): string {
  return sealTeamInviteBoxWithIv(input, randomBytes(TEAM_IV_BYTE_LENGTH));
}

// 고정 벡터 검증용으로 iv 를 받는 변형. 제품 경로는 sealTeamInviteBox 를 쓴다.
export function sealTeamInviteBoxWithIv(
  input: { secret: Uint8Array; teamId: string; teamDek: Uint8Array; expiresAt: string },
  iv: Uint8Array,
): string {
  assertSecret(input.secret);
  assertKey(input.teamDek);
  const plaintext = utf8ToBytes(
    JSON.stringify({
      v: TEAM_INVITE_BOX_VERSION,
      teamId: input.teamId,
      teamDek: bytesToBase64(input.teamDek),
      expiresAt: input.expiresAt,
    }),
  );
  const key = deriveInviteKey(input.secret, TEAM_INVITE_BOX_INFO);
  const sealed = gcm(key, iv, utf8ToBytes(TEAM_INVITE_BOX_AAD_PREFIX + input.teamId)).encrypt(plaintext);
  return bytesToBase64(concatBytes(iv, sealed));
}

/**
 * 상자를 연다. 팀 ID 는 서버가 참여 응답으로 준 값이다 — 상자 안의 팀 ID 와 다르면(다른 팀의 상자)
 * 열리지 않는다. 기한이 지났으면 "expired" 다.
 */
export function openTeamInviteBox(input: {
  secret: Uint8Array;
  teamId: string;
  box: string;
  now?: Date;
}): OpenedTeamInviteBox {
  assertSecret(input.secret);
  const [iv, sealed] = splitSealed(input.box, "잘못된 초대 상자 형식입니다.");
  const key = deriveInviteKey(input.secret, TEAM_INVITE_BOX_INFO);
  const plaintext = decryptOrThrow(key, iv, sealed, TEAM_INVITE_BOX_AAD_PREFIX + input.teamId);
  let content: { v?: unknown; teamId?: unknown; teamDek?: unknown; expiresAt?: unknown };
  try {
    content = JSON.parse(new TextDecoder().decode(plaintext)) as typeof content;
  } catch {
    throw new TeamCryptoError("malformed", "잘못된 초대 상자 형식입니다.");
  }
  if (content.v !== TEAM_INVITE_BOX_VERSION) {
    throw new TeamCryptoError("unsupported-version", "이 초대 링크를 열려면 앱을 업데이트해야 합니다.");
  }
  if (content.teamId !== input.teamId || typeof content.teamDek !== "string" || typeof content.expiresAt !== "string") {
    throw new TeamCryptoError("malformed", "잘못된 초대 상자 형식입니다.");
  }
  const expiresAt = Date.parse(content.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new TeamCryptoError("malformed", "잘못된 초대 상자 형식입니다.");
  }
  if ((input.now ?? new Date()).getTime() >= expiresAt) {
    throw new TeamCryptoError("expired", "초대 링크의 기한이 지났습니다.");
  }
  let teamDek: Uint8Array;
  try {
    teamDek = base64ToBytes(content.teamDek);
  } catch {
    throw new TeamCryptoError("malformed", "잘못된 초대 상자 형식입니다.");
  }
  if (teamDek.length !== TEAM_DEK_BYTE_LENGTH) {
    throw new TeamCryptoError("malformed", "잘못된 초대 상자 형식입니다.");
  }
  return { teamDek, expiresAt: content.expiresAt };
}

/**
 * 링크 비밀값을 팀 키로 잠근다(잠근 비밀값). 링크와 함께 서버에 올려, 멤버가 링크가 살아 있는 동안 목록에서
 * 다시 복사할 수 있게 한다.
 */
export function sealTeamInviteSecret(input: { secret: Uint8Array; teamId: string; teamDek: Uint8Array }): string {
  return sealTeamInviteSecretWithIv(input, randomBytes(TEAM_IV_BYTE_LENGTH));
}

// 고정 벡터 검증용으로 iv 를 받는 변형. 제품 경로는 sealTeamInviteSecret 을 쓴다.
export function sealTeamInviteSecretWithIv(
  input: { secret: Uint8Array; teamId: string; teamDek: Uint8Array },
  iv: Uint8Array,
): string {
  assertSecret(input.secret);
  const plaintext = utf8ToBytes(
    JSON.stringify({ v: TEAM_INVITE_SECRET_VERSION, secret: bytesToBase64(input.secret) }),
  );
  const key = deriveInviteSecretKey(input.teamDek, input.teamId);
  const sealed = gcm(key, iv, utf8ToBytes(TEAM_INVITE_SECRET_PREFIX + input.teamId)).encrypt(plaintext);
  return bytesToBase64(concatBytes(iv, sealed));
}

/** 잠근 비밀값을 연다. 다른 팀 키·다른 팀 ID 로 잠근 것이면 "wrong-key" 다. */
export function openTeamInviteSecret(input: { sealed: string; teamId: string; teamDek: Uint8Array }): Uint8Array {
  const [iv, sealed] = splitSealed(input.sealed, "잘못된 링크 비밀값 형식입니다.");
  const key = deriveInviteSecretKey(input.teamDek, input.teamId);
  const plaintext = decryptOrThrow(key, iv, sealed, TEAM_INVITE_SECRET_PREFIX + input.teamId);
  let content: { v?: unknown; secret?: unknown };
  try {
    content = JSON.parse(new TextDecoder().decode(plaintext)) as typeof content;
  } catch {
    throw new TeamCryptoError("malformed", "잘못된 링크 비밀값 형식입니다.");
  }
  if (content.v !== TEAM_INVITE_SECRET_VERSION) {
    throw new TeamCryptoError("unsupported-version", "이 초대 링크를 열려면 앱을 업데이트해야 합니다.");
  }
  if (typeof content.secret !== "string") {
    throw new TeamCryptoError("malformed", "잘못된 링크 비밀값 형식입니다.");
  }
  let secret: Uint8Array;
  try {
    secret = base64ToBytes(content.secret);
  } catch {
    throw new TeamCryptoError("malformed", "잘못된 링크 비밀값 형식입니다.");
  }
  if (secret.length !== TEAM_INVITE_SECRET_BYTE_LENGTH) {
    throw new TeamCryptoError("malformed", "잘못된 링크 비밀값 형식입니다.");
  }
  return secret;
}

export function formatTeamInviteLink(serverUrl: string, code: string, secret: Uint8Array): string {
  assertSecret(secret);
  const base = serverUrl.trim().replace(/\/+$/, "");
  return `${base}/invite/${code}#${TEAM_INVITE_LINK_VERSION}.${bytesToBase64Url(secret)}`;
}

/**
 * 붙여 넣거나 브라우저에서 넘어온 링크를 읽는다. 서버 주소는 `/invite/` 앞까지다 — 자체 호스팅이
 * 경로 아래에 있어도 맞게 읽는다.
 */
export function parseTeamInviteLink(value: string): TeamInviteLink {
  const trimmed = value.trim();
  const hashIndex = trimmed.indexOf("#");
  if (hashIndex < 0) {
    throw new TeamCryptoError("malformed", "초대 링크가 잘렸습니다.");
  }
  const fragment = trimmed.slice(hashIndex + 1);
  const prefix = `${TEAM_INVITE_LINK_VERSION}.`;
  if (!fragment.startsWith(prefix)) {
    if (/^v\d+\./.test(fragment)) {
      throw new TeamCryptoError("unsupported-version", "이 초대 링크를 열려면 앱을 업데이트해야 합니다.");
    }
    throw new TeamCryptoError("malformed", "초대 링크가 잘렸습니다.");
  }
  let secret: Uint8Array;
  try {
    secret = base64UrlToBytes(fragment.slice(prefix.length));
  } catch {
    throw new TeamCryptoError("malformed", "초대 링크가 잘렸습니다.");
  }
  if (secret.length !== TEAM_INVITE_SECRET_BYTE_LENGTH) {
    throw new TeamCryptoError("malformed", "초대 링크가 잘렸습니다.");
  }
  let url: URL;
  try {
    url = new URL(trimmed.slice(0, hashIndex));
  } catch {
    throw new TeamCryptoError("malformed", "초대 링크 주소가 올바르지 않습니다.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TeamCryptoError("malformed", "초대 링크 주소가 올바르지 않습니다.");
  }
  const marker = "/invite/";
  const markerIndex = url.pathname.lastIndexOf(marker);
  const code = markerIndex >= 0 ? url.pathname.slice(markerIndex + marker.length).replace(/\/+$/, "") : "";
  if (!TEAM_INVITE_CODE_PATTERN.test(code)) {
    throw new TeamCryptoError("malformed", "초대 링크 주소가 올바르지 않습니다.");
  }
  return {
    serverUrl: `${url.origin}${url.pathname.slice(0, markerIndex)}`,
    code,
    secret,
  };
}

function deriveInviteKey(secret: Uint8Array, info: string): Uint8Array {
  assertSecret(secret);
  return hkdf(sha256, secret, undefined, utf8ToBytes(info), 32);
}

function deriveInviteSecretKey(teamDek: Uint8Array, teamId: string): Uint8Array {
  assertKey(teamDek);
  return hkdf(sha256, teamDek, undefined, utf8ToBytes(TEAM_INVITE_SECRET_PREFIX + teamId), 32);
}

function decryptOrThrow(key: Uint8Array, iv: Uint8Array, sealed: Uint8Array, aad: string): Uint8Array {
  try {
    return gcm(key, iv, utf8ToBytes(aad)).decrypt(sealed);
  } catch {
    // GCM 인증 실패 — 열쇠·팀 ID·내용 중 하나가 맞지 않는다.
    throw new TeamCryptoError("wrong-key", "팀 키를 열 수 없습니다.");
  }
}

function splitSealed(value: string, malformedMessage: string): [Uint8Array, Uint8Array] {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(value);
  } catch {
    throw new TeamCryptoError("malformed", malformedMessage);
  }
  if (bytes.length <= TEAM_IV_BYTE_LENGTH + 16) {
    throw new TeamCryptoError("malformed", malformedMessage);
  }
  return [bytes.slice(0, TEAM_IV_BYTE_LENGTH), bytes.slice(TEAM_IV_BYTE_LENGTH)];
}

function assertKey(key: Uint8Array): void {
  if (key.length !== TEAM_DEK_BYTE_LENGTH) {
    throw new TeamCryptoError("malformed", "잘못된 키 길이입니다.");
  }
}

function assertSecret(secret: Uint8Array): void {
  if (secret.length !== TEAM_INVITE_SECRET_BYTE_LENGTH) {
    throw new TeamCryptoError("malformed", "잘못된 초대 비밀값 길이입니다.");
  }
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("잘못된 base64url 입력입니다.");
  }
  return base64ToBytes(value.replace(/-/g, "+").replace(/_/g, "/"));
}
