import { createCipheriv, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createTeamDek,
  createTeamInviteSecret,
  deriveTeamInviteJoinToken,
  formatTeamInviteLink,
  hashTeamInviteJoinToken,
  openTeamInviteBox,
  openTeamInviteSecret,
  parseTeamInviteLink,
  sealTeamInviteBox,
  sealTeamInviteBoxWithIv,
  sealTeamInviteSecret,
  sealTeamInviteSecretWithIv,
  TeamCryptoError,
  unwrapTeamDek,
  wrapTeamDek,
  wrapTeamDekWithIv,
} from "@dolssh/shared-core";
import teamTestVectors from "@dolssh/shared-core/src/team-test-vectors.json";

// 팀 키 사본·초대 링크 형식. 벡터는 Node 내장 crypto 로 따로 만든 값이라, 여기서 맞으면 noble 구현이
// 형식을 그대로 따른다는 뜻이다. 한 번 나간 사본·링크는 이 형식으로만 열린다.

const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"));

function expectTeamCryptoError(run: () => unknown, code: TeamCryptoError["code"]) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TeamCryptoError);
    expect((error as TeamCryptoError).code).toBe(code);
    return;
  }
  throw new Error(`expected TeamCryptoError(${code})`);
}

describe("team key copies", () => {
  it("matches the shared wrap vectors", () => {
    for (const vector of teamTestVectors.wrap) {
      const teamDek = bytes(vector.teamDekBase64);
      const personalDek = bytes(vector.personalDekBase64);
      expect(wrapTeamDekWithIv(teamDek, personalDek, vector.teamId, bytes(vector.ivBase64))).toBe(vector.wrappedBase64);
      expect(Buffer.from(unwrapTeamDek(vector.wrappedBase64, personalDek, vector.teamId)).toString("base64")).toBe(vector.teamDekBase64);
    }
  });

  it("does not open with another personal DEK or another team's id", () => {
    const [vector] = teamTestVectors.wrap;
    const personalDek = bytes(vector.personalDekBase64);
    expectTeamCryptoError(() => unwrapTeamDek(vector.wrappedBase64, new Uint8Array(32).fill(9), vector.teamId), "wrong-key");
    expectTeamCryptoError(() => unwrapTeamDek(vector.wrappedBase64, personalDek, "another-team"), "wrong-key");
    expectTeamCryptoError(() => unwrapTeamDek("not base64!", personalDek, vector.teamId), "malformed");
  });

  it("round-trips fresh keys", () => {
    const teamDek = createTeamDek();
    const personalDek = createTeamDek();
    const wrapped = wrapTeamDek(teamDek, personalDek, "team-1");
    expect(unwrapTeamDek(wrapped, personalDek, "team-1")).toEqual(teamDek);
    expect(wrapTeamDek(teamDek, personalDek, "team-1")).not.toBe(wrapped);
  });
});

describe("team invite links", () => {
  it("matches the shared invite vectors", () => {
    for (const vector of teamTestVectors.invite) {
      const secret = bytes(vector.secretBase64);
      const token = deriveTeamInviteJoinToken(secret);
      expect(token).toBe(vector.joinToken);
      expect(hashTeamInviteJoinToken(token)).toBe(vector.joinTokenHash);
      expect(
        sealTeamInviteBoxWithIv(
          { secret, teamId: vector.teamId, teamDek: bytes(vector.teamDekBase64), expiresAt: vector.expiresAt },
          bytes(vector.ivBase64),
        ),
      ).toBe(vector.boxBase64);
      const opened = openTeamInviteBox({ secret, teamId: vector.teamId, box: vector.boxBase64, now: new Date("2026-01-01T00:00:00Z") });
      expect(Buffer.from(opened.teamDek).toString("base64")).toBe(vector.teamDekBase64);
      expect(opened.expiresAt).toBe(vector.expiresAt);
      expect(formatTeamInviteLink(vector.serverUrl, vector.code, secret)).toBe(vector.link);
      const parsed = parseTeamInviteLink(vector.link);
      expect(parsed.serverUrl).toBe(vector.serverUrl);
      expect(parsed.code).toBe(vector.code);
      expect(Buffer.from(parsed.secret).toString("base64")).toBe(vector.secretBase64);
    }
  });

  it("refuses a wrong secret, another team's box and an expired box", () => {
    const [vector] = teamTestVectors.invite;
    const secret = bytes(vector.secretBase64);
    const before = new Date("2026-01-01T00:00:00Z");
    expectTeamCryptoError(() => openTeamInviteBox({ secret: new Uint8Array(32).fill(1), teamId: vector.teamId, box: vector.boxBase64, now: before }), "wrong-key");
    // 서버가 다른 팀의 상자를 내줘도 그 팀 ID 로는 열리지 않는다.
    expectTeamCryptoError(() => openTeamInviteBox({ secret, teamId: "another-team", box: vector.boxBase64, now: before }), "wrong-key");
    // 기한은 상자 안에도 있다 — 서버가 지난 상자를 내줘도 앱이 거절한다.
    expectTeamCryptoError(() => openTeamInviteBox({ secret, teamId: vector.teamId, box: vector.boxBase64, now: new Date(vector.expiresAt) }), "expired");
  });

  it("keeps the join token apart from the box key", () => {
    const secret = createTeamInviteSecret();
    const teamDek = createTeamDek();
    const box = sealTeamInviteBox({ secret, teamId: "team-1", teamDek, expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(openTeamInviteBox({ secret, teamId: "team-1", box }).teamDek).toEqual(teamDek);
    expect(deriveTeamInviteJoinToken(secret)).not.toBe(Buffer.from(secret).toString("base64url"));
  });

  it("rejects links it cannot read and asks for an update on a newer format", () => {
    const [vector] = teamTestVectors.invite;
    expectTeamCryptoError(() => parseTeamInviteLink(vector.link.replace("#v1.", "#v2.")), "unsupported-version");
    for (const broken of [
      vector.link.split("#")[0],
      vector.link.slice(0, -5),
      vector.link.replace("/invite/", "/join/"),
      vector.link.replace("https://", "ftp://"),
      "#v1." + vector.link.split("#v1.")[1],
    ]) {
      expectTeamCryptoError(() => parseTeamInviteLink(broken), "malformed");
    }
  });
});

describe("sealed invite secrets", () => {
  it("matches the shared sealed-secret vectors", () => {
    for (const vector of teamTestVectors.inviteSecret) {
      const teamDek = bytes(vector.teamDekBase64);
      const secret = bytes(vector.secretBase64);
      expect(sealTeamInviteSecretWithIv({ secret, teamId: vector.teamId, teamDek }, bytes(vector.ivBase64))).toBe(vector.sealedBase64);
      const opened = openTeamInviteSecret({ sealed: vector.sealedBase64, teamId: vector.teamId, teamDek });
      expect(Buffer.from(opened).toString("base64")).toBe(vector.secretBase64);
    }
  });

  it("opens only with the team's own key and id", () => {
    const [vector] = teamTestVectors.inviteSecret;
    const teamDek = bytes(vector.teamDekBase64);
    expectTeamCryptoError(() => openTeamInviteSecret({ sealed: vector.sealedBase64, teamId: vector.teamId, teamDek: createTeamDek() }), "wrong-key");
    // 서버가 다른 팀의 것을 내줘도 그 팀 ID 로는 열리지 않는다.
    expectTeamCryptoError(() => openTeamInviteSecret({ sealed: vector.sealedBase64, teamId: "another-team", teamDek }), "wrong-key");
    expectTeamCryptoError(() => openTeamInviteSecret({ sealed: "not base64!", teamId: vector.teamId, teamDek }), "malformed");
  });

  it("asks for an update when the sealed secret is a newer format", () => {
    const [vector] = teamTestVectors.inviteSecret;
    const aad = Buffer.from(`dolgate-team-invite-secret-v1|${vector.teamId}`, "utf8");
    const key = Buffer.from(hkdfSync("sha256", bytes(vector.teamDekBase64), Buffer.alloc(0), aad, 32));
    const iv = Buffer.alloc(12, 1);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const plaintext = Buffer.from(JSON.stringify({ v: 2, secret: vector.secretBase64 }), "utf8");
    const sealed = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString("base64");
    expectTeamCryptoError(
      () => openTeamInviteSecret({ sealed, teamId: vector.teamId, teamDek: bytes(vector.teamDekBase64) }),
      "unsupported-version",
    );
  });

  it("round-trips fresh values without carrying the secret in the clear", () => {
    const secret = createTeamInviteSecret();
    const teamDek = createTeamDek();
    const sealed = sealTeamInviteSecret({ secret, teamId: "team-1", teamDek });
    expect(openTeamInviteSecret({ sealed, teamId: "team-1", teamDek })).toEqual(secret);
    expect(sealTeamInviteSecret({ secret, teamId: "team-1", teamDek })).not.toBe(sealed);
    const sealedBytes = Buffer.from(sealed, "base64");
    expect(sealedBytes.includes(Buffer.from(secret))).toBe(false);
    expect(sealed).not.toContain(Buffer.from(secret).toString("base64"));
  });
});
