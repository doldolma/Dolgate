import { describe, expect, it } from "vitest";
import {
  createTeamDek,
  deriveTeamReplayKey,
  isTeamCryptoError,
  openTeamEventBody,
  openTeamReplayBytes,
  openTeamReplayJson,
  sealTeamEventBody,
  sealTeamReplayBytes,
  sealTeamReplayJson,
} from "@shared";

const TEAM = "team-a";

function cryptoCode(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return isTeamCryptoError(error) ? error.code : "other";
  }
}

describe("team history crypto", () => {
  it("round-trips an activity body bound to its team and event", () => {
    const dek = createTeamDek();
    const sealed = sealTeamEventBody(dek, TEAM, "event-1", { v: 1, hello: "world" } as never);
    expect(openTeamEventBody(dek, TEAM, "event-1", sealed)).toEqual({ v: 1, hello: "world" });
    // 다른 줄·다른 팀·다른 열쇠로는 풀리지 않는다 — 서버가 옮겨 놓아도 소용없다.
    expect(cryptoCode(() => openTeamEventBody(dek, TEAM, "event-2", sealed))).toBe("wrong-key");
    expect(cryptoCode(() => openTeamEventBody(dek, "team-b", "event-1", sealed))).toBe("wrong-key");
    expect(cryptoCode(() => openTeamEventBody(createTeamDek(), TEAM, "event-1", sealed))).toBe("wrong-key");
    expect(cryptoCode(() => openTeamEventBody(dek, TEAM, "event-1", "not base64!"))).toBe("malformed");
  });

  it("asks for an update when the body is a newer format", () => {
    const dek = createTeamDek();
    const sealed = sealTeamEventBody(dek, TEAM, "event-1", { v: 2 });
    expect(cryptoCode(() => openTeamEventBody(dek, TEAM, "event-1", sealed))).toBe("unsupported-version");
  });

  it("gives every recording its own key and binds each piece to its purpose and number", () => {
    const dek = createTeamDek();
    const key = deriveTeamReplayKey(dek, TEAM, "rec-1");
    expect(deriveTeamReplayKey(dek, TEAM, "rec-2")).not.toEqual(key);
    expect(deriveTeamReplayKey(dek, "team-b", "rec-1")).not.toEqual(key);

    const segment = new Uint8Array([1, 2, 3, 4, 5]);
    const sealed = sealTeamReplayBytes(key, "rec-1", "segment:3", segment);
    expect(openTeamReplayBytes(key, "rec-1", "segment:3", sealed)).toEqual(segment);
    // 순서를 바꾸거나(다른 번호) 덧붙임 자리에 넣거나 다른 녹화로 옮기면 풀리지 않는다.
    expect(cryptoCode(() => openTeamReplayBytes(key, "rec-1", "segment:4", sealed))).toBe("wrong-key");
    expect(cryptoCode(() => openTeamReplayBytes(key, "rec-1", "commands:3", sealed))).toBe("wrong-key");
    expect(cryptoCode(() => openTeamReplayBytes(deriveTeamReplayKey(dek, TEAM, "rec-2"), "rec-2", "segment:3", sealed))).toBe("wrong-key");

    const meta = sealTeamReplayJson(key, "rec-1", "start", { v: 1, hostLabel: "web-1" } as never);
    expect(openTeamReplayJson(key, "rec-1", "start", meta)).toEqual({ v: 1, hostLabel: "web-1" });
    expect(cryptoCode(() => openTeamReplayJson(key, "rec-1", "end", meta))).toBe("wrong-key");
  });
});
