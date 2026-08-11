import { describe, expect, it } from "vitest";
import { projectSecretMetadata, type ManagedSecretPayload } from "@shared";

// 자격증명 페이로드 → 목록 메타데이터 투영. 필드를 나열하는 화이트리스트라, 하나라도 빠지면 그
// 값이 조용히 증발한다 — pull 은 받은 페이로드로 secretMetadata 를 통째로 재구성하므로 전 기기에서
// 사라진다. kind 가 실제로 그랬다(RDP 자격증명이 SSH 취급으로 강등돼 RDP 폼 목록에서 사라짐).
//
// 이 투영은 세 경로(동기화 pull·번들 가져오기·모바일)가 공유한다. 그래서 여기 한 곳만 잠그면
// 세 경로가 같이 잠긴다 — 예전처럼 각자 복사해 두면 한 곳만 고치고 나머지가 갈렸다.
const CONTEXT = { linkedHostCount: 0, updatedAt: "2026-08-11T00:00:00.000Z" };

describe("projectSecretMetadata", () => {
  it("keeps kind and account fields of an RDP credential", () => {
    const payload: ManagedSecretPayload = {
      secretRef: "secret:rdp-cred",
      label: "Work PC admin",
      kind: "rdp",
      username: " admin ",
      domain: "WORKGROUP",
      password: "hunter2",
      updatedAt: "2026-08-11T00:00:00.000Z",
    };

    expect(projectSecretMetadata(payload, CONTEXT)).toMatchObject({
      secretRef: "secret:rdp-cred",
      kind: "rdp",
      username: "admin",
      domain: "WORKGROUP",
      hasPassword: true,
    });
  });

  it("leaves a legacy SSH credential without kind as null (treated as SSH)", () => {
    const payload: ManagedSecretPayload = {
      secretRef: "secret:ssh-cred",
      label: "old key",
      privateKeyPem: "-----BEGIN OPENSSH PRIVATE KEY-----",
      updatedAt: "2026-08-11T00:00:00.000Z",
    };

    expect(projectSecretMetadata(payload, CONTEXT)).toMatchObject({
      kind: null,
      username: null,
      domain: null,
      hasManagedPrivateKey: true,
      hasPassword: false,
    });
  });

  // 키 상세는 자격증명 화면이 "암호화된 키인지, 어떤 알고리즘인지"를 보여주는 데 쓴다. 빠뜨려도
  // 화면이 조용히 비기만 해서 눈치채기 어렵다 — 값이 있으면 그대로 실려 나가는지 함께 잠근다.
  it("carries the key detail fields through", () => {
    const payload: ManagedSecretPayload = {
      secretRef: "secret:key-cred",
      label: "ed25519",
      privateKeyPem: "-----BEGIN OPENSSH PRIVATE KEY-----",
      privateKeyEncrypted: true,
      keyAlgorithm: "ssh-ed25519",
      keyCurve: "ed25519",
      keyBits: 256,
      privateKeyCipher: "aes256-ctr",
      privateKeyKdfRounds: 16,
      passphraseSaved: true,
      certificateText: "ssh-ed25519-cert-v01@openssh.com AAAA",
      updatedAt: "2026-08-11T00:00:00.000Z",
    };

    expect(projectSecretMetadata(payload, CONTEXT)).toMatchObject({
      privateKeyEncrypted: true,
      keyAlgorithm: "ssh-ed25519",
      keyCurve: "ed25519",
      keyBits: 256,
      privateKeyCipher: "aes256-ctr",
      privateKeyKdfRounds: 16,
      passphraseSaved: true,
      hasCertificate: true,
    });
  });

  // linkedHostCount·updatedAt 은 페이로드에서 나오지 않는다. 모바일은 호스트 목록에서 세어 넣고
  // 가져오기는 번들에 적힌 시각을 쓰므로, 호출부가 준 값이 그대로 나가야 한다.
  it("takes linkedHostCount and updatedAt from the caller", () => {
    const payload: ManagedSecretPayload = {
      secretRef: "secret:shared",
      label: "shared",
      password: "x",
      updatedAt: "2020-01-01T00:00:00.000Z",
    };

    expect(
      projectSecretMetadata(payload, {
        linkedHostCount: 3,
        updatedAt: "2026-12-24T00:00:00.000Z",
      }),
    ).toMatchObject({
      linkedHostCount: 3,
      updatedAt: "2026-12-24T00:00:00.000Z",
    });
  });
});
