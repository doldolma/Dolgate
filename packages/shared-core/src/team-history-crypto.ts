import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64ToBytes, bytesToBase64 } from "./base64";
import { TEAM_DEK_BYTE_LENGTH, TeamCryptoError } from "./team-crypto";

// 팀 기록·녹화의 암호. 서버는 크기와 순서만 보고 내용은 모른다.
//
//   기록 열쇠  = HKDF-SHA256(팀 DEK, info "dolgate-team-event-v1|<팀 ID>")
//   기록      = AES-256-GCM(기록 열쇠, iv, 본문 JSON, AAD "dolgate-team-event-v1|<팀 ID>|<기록 ID>")
//               → base64(iv(12) || ciphertext || tag(16))
//   녹화 열쇠  = HKDF-SHA256(팀 DEK, info "dolgate-team-replay-v1|<팀 ID>|<녹화 ID>")
//   녹화 조각  = AES-256-GCM(녹화 열쇠, iv, 내용, AAD "dolgate-team-replay-v1|<녹화 ID>|<쓰임>")
//               쓰임: start·end(메타), info:<n>(구간 정보), segment:<n>(구간), commands:<n>·snapshot:<n>(덧붙임)
//
// 녹화마다 열쇠를 따로 뽑아 한 열쇠로 잠그는 횟수를 녹화 하나 안으로 묶는다(무작위 iv 의 한도). AAD 에 녹화 ID·
// 쓰임·번호를 묶어, 서버가 순서를 바꾸거나 다른 녹화·다른 팀의 것을 섞어 내줘도 풀리지 않는다.
// 본문 JSON 에는 형식 버전(v)을 둔다 — 모르는 버전이면 "unsupported-version" 으로 업데이트를 안내한다.

/** 이 빌드가 쓰고 읽는 기록·녹화 형식. */
export const TEAM_HISTORY_FORMAT_VERSION = 1;

const IV_BYTE_LENGTH = 12;
const TAG_BYTE_LENGTH = 16;
const EVENT_INFO_PREFIX = "dolgate-team-event-v1|";
const REPLAY_INFO_PREFIX = "dolgate-team-replay-v1|";

/** 녹화 조각의 쓰임. 번호가 붙는 것은 그 구간 번호다. */
export type TeamReplayPurpose =
  | "start"
  | "end"
  | `info:${number}`
  | `segment:${number}`
  | `commands:${number}`
  | `snapshot:${number}`;

function assertTeamKey(key: Uint8Array): void {
  if (key.length !== TEAM_DEK_BYTE_LENGTH) {
    throw new TeamCryptoError("malformed", "잘못된 키 길이입니다.");
  }
}

function seal(key: Uint8Array, aad: string, plaintext: Uint8Array): Uint8Array {
  const iv = randomBytes(IV_BYTE_LENGTH);
  const sealed = gcm(key, iv, utf8ToBytes(aad)).encrypt(plaintext);
  const output = new Uint8Array(iv.length + sealed.length);
  output.set(iv, 0);
  output.set(sealed, iv.length);
  return output;
}

function open(key: Uint8Array, aad: string, sealed: Uint8Array): Uint8Array {
  if (sealed.length <= IV_BYTE_LENGTH + TAG_BYTE_LENGTH - 1) {
    throw new TeamCryptoError("malformed", "잘못된 팀 기록 형식입니다.");
  }
  try {
    return gcm(key, sealed.subarray(0, IV_BYTE_LENGTH), utf8ToBytes(aad)).decrypt(sealed.subarray(IV_BYTE_LENGTH));
  } catch {
    // GCM 인증 실패 — 열쇠·팀·녹화·쓰임·내용 중 하나가 맞지 않는다.
    throw new TeamCryptoError("wrong-key", "팀 기록을 열 수 없습니다.");
  }
}

function decodeBase64(value: string): Uint8Array {
  try {
    return base64ToBytes(value);
  } catch {
    throw new TeamCryptoError("malformed", "잘못된 팀 기록 형식입니다.");
  }
}

function encodeJson(value: { v: number }): Uint8Array {
  return utf8ToBytes(JSON.stringify(value));
}

function decodeJson<T extends { v: number }>(plaintext: Uint8Array): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new TeamCryptoError("malformed", "잘못된 팀 기록 형식입니다.");
  }
  const version = (parsed as { v?: unknown } | null)?.v;
  if (typeof version !== "number") {
    throw new TeamCryptoError("malformed", "잘못된 팀 기록 형식입니다.");
  }
  if (version > TEAM_HISTORY_FORMAT_VERSION) {
    throw new TeamCryptoError("unsupported-version", "앱을 업데이트하면 볼 수 있습니다.");
  }
  return parsed as T;
}

function deriveEventKey(teamDek: Uint8Array, teamId: string): Uint8Array {
  assertTeamKey(teamDek);
  return hkdf(sha256, teamDek, undefined, utf8ToBytes(EVENT_INFO_PREFIX + teamId), 32);
}

/** 앱 활동 기록 한 줄을 잠근다. 본문에는 형식 버전(v)이 있어야 한다. */
export function sealTeamEventBody(teamDek: Uint8Array, teamId: string, eventId: string, body: { v: number }): string {
  const key = deriveEventKey(teamDek, teamId);
  return bytesToBase64(seal(key, `${EVENT_INFO_PREFIX}${teamId}|${eventId}`, encodeJson(body)));
}

/** 기록 한 줄을 푼다. 다른 팀·다른 줄 것이면 "wrong-key", 모르는 형식이면 "unsupported-version" 이다. */
export function openTeamEventBody<T extends { v: number }>(teamDek: Uint8Array, teamId: string, eventId: string, sealed: string): T {
  const key = deriveEventKey(teamDek, teamId);
  return decodeJson<T>(open(key, `${EVENT_INFO_PREFIX}${teamId}|${eventId}`, decodeBase64(sealed)));
}

/** 녹화 하나의 열쇠. 녹화의 모든 조각을 이것으로 잠근다. */
export function deriveTeamReplayKey(teamDek: Uint8Array, teamId: string, recordingId: string): Uint8Array {
  assertTeamKey(teamDek);
  return hkdf(sha256, teamDek, undefined, utf8ToBytes(`${REPLAY_INFO_PREFIX}${teamId}|${recordingId}`), 32);
}

function replayAad(recordingId: string, purpose: TeamReplayPurpose): string {
  return `${REPLAY_INFO_PREFIX}${recordingId}|${purpose}`;
}

/** 녹화의 바이트 조각(구간·덧붙임)을 잠근다. 결과는 iv || ciphertext || tag 다. */
export function sealTeamReplayBytes(replayKey: Uint8Array, recordingId: string, purpose: TeamReplayPurpose, data: Uint8Array): Uint8Array {
  assertTeamKey(replayKey);
  return seal(replayKey, replayAad(recordingId, purpose), data);
}

export function openTeamReplayBytes(replayKey: Uint8Array, recordingId: string, purpose: TeamReplayPurpose, sealed: Uint8Array): Uint8Array {
  assertTeamKey(replayKey);
  return open(replayKey, replayAad(recordingId, purpose), sealed);
}

/** 녹화의 JSON 조각(메타·구간 정보)을 잠근다. 본문에는 형식 버전(v)이 있어야 한다. */
export function sealTeamReplayJson(replayKey: Uint8Array, recordingId: string, purpose: TeamReplayPurpose, value: { v: number }): string {
  return bytesToBase64(sealTeamReplayBytes(replayKey, recordingId, purpose, encodeJson(value)));
}

export function openTeamReplayJson<T extends { v: number }>(replayKey: Uint8Array, recordingId: string, purpose: TeamReplayPurpose, sealed: string): T {
  return decodeJson<T>(openTeamReplayBytes(replayKey, recordingId, purpose, decodeBase64(sealed)));
}
