import { describe, expect, it } from "vitest";
import type { PendingHostKeyPrompt } from "../types";
import {
  dropHostKeyPromptsForSession,
  enqueueHostKeyPrompt,
  remapHostKeyPromptSessionId,
  shiftHostKeyPrompt,
} from "./host-key-prompts";

function createPrompt(
  challengeId: string,
  overrides: Partial<PendingHostKeyPrompt> = {},
): PendingHostKeyPrompt {
  return {
    sessionId: null,
    liveChallengeId: challengeId,
    probe: {
      hostId: "host-1",
      hostLabel: "prod",
      host: `${challengeId}.example.com`,
      port: 22,
      targetDescription: null,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAA",
      fingerprintSha256: `SHA256:${challengeId}`,
      status: "untrusted",
      existing: null,
    },
    action: { kind: "containers", hostId: "host-1" },
    ...overrides,
  } as PendingHostKeyPrompt;
}

const empty = { pendingHostKeyPrompt: null, queuedHostKeyPrompts: [] };

describe("호스트 키 신뢰 물음 큐", () => {
  // 덮어쓰기가 이 큐를 만든 이유다.
  //
  // 슬롯이 하나뿐이면 뒤에 온 물음이 앞의 것을 지우고, 지워진 물음은 아무도 답할 수 없다 —
  // 그 연결은 코어의 예산(5분)이 다 될 때까지 "연결 중…"에 앉아 있는다.
  it("이미 보여 주는 물음이 있으면 덮지 않고 줄을 세운다", () => {
    const first = enqueueHostKeyPrompt(empty, createPrompt("a"));
    const second = enqueueHostKeyPrompt(first, createPrompt("b"));

    expect(second.pendingHostKeyPrompt?.liveChallengeId).toBe("a");
    expect(second.queuedHostKeyPrompts.map((p) => p.liveChallengeId)).toEqual(["b"]);
  });

  it("보여 주는 것이 없으면 바로 띄운다", () => {
    const next = enqueueHostKeyPrompt(empty, createPrompt("a"));
    expect(next.pendingHostKeyPrompt?.liveChallengeId).toBe("a");
    expect(next.queuedHostKeyPrompts).toEqual([]);
  });

  // 답한 뒤 다음을 안 올리면 줄에 선 물음이 영영 안 뜬다 — 덮어쓰기와 증상이 같다.
  it("하나를 끝내면 다음을 올린다", () => {
    const queued = enqueueHostKeyPrompt(
      enqueueHostKeyPrompt(empty, createPrompt("a")),
      createPrompt("b"),
    );

    const after = shiftHostKeyPrompt(queued);

    expect(after.pendingHostKeyPrompt?.liveChallengeId).toBe("b");
    expect(after.queuedHostKeyPrompts).toEqual([]);
    expect(shiftHostKeyPrompt(after).pendingHostKeyPrompt).toBeNull();
  });

  // 같은 물음이 두 번 오면 사용자가 같은 지문을 두 번 승인해야 한다.
  it("같은 챌린지가 다시 와도 쌓이지 않는다", () => {
    const first = enqueueHostKeyPrompt(empty, createPrompt("a"));
    const again = enqueueHostKeyPrompt(first, createPrompt("a"));
    expect(again.queuedHostKeyPrompts).toEqual([]);

    const queued = enqueueHostKeyPrompt(again, createPrompt("b"));
    const dupe = enqueueHostKeyPrompt(queued, createPrompt("b"));
    expect(dupe.queuedHostKeyPrompts).toHaveLength(1);
  });

  // 세션이 사라지면 그 물음은 답할 대상이 없다. 줄에 남겨 두면 나중에 엉뚱하게 올라온다.
  it("사라진 세션의 물음은 줄에서도 걷어낸다", () => {
    const state = enqueueHostKeyPrompt(
      enqueueHostKeyPrompt(empty, createPrompt("a", { sessionId: "session-1" })),
      createPrompt("b", { sessionId: "session-2" }),
    );

    const after = dropHostKeyPromptsForSession(state, "session-1");

    expect(after.pendingHostKeyPrompt?.liveChallengeId).toBe("b");
    expect(after.queuedHostKeyPrompts).toEqual([]);
  });

  it("보여 주는 것이 남을 세션이면 그것은 그대로 둔다", () => {
    const state = enqueueHostKeyPrompt(
      enqueueHostKeyPrompt(empty, createPrompt("a", { sessionId: "session-1" })),
      createPrompt("b", { sessionId: "session-2" }),
    );

    const after = dropHostKeyPromptsForSession(state, "session-2");

    expect(after.pendingHostKeyPrompt?.liveChallengeId).toBe("a");
    expect(after.queuedHostKeyPrompts).toEqual([]);
  });

  // 재연결로 세션 ID 가 바뀌면 줄에 선 것까지 함께 옮겨야 한다.
  it("세션 ID 가 바뀌면 줄에 선 물음도 따라간다", () => {
    const state = enqueueHostKeyPrompt(
      enqueueHostKeyPrompt(empty, createPrompt("a", { sessionId: "old" })),
      createPrompt("b", { sessionId: "old" }),
    );

    const after = remapHostKeyPromptSessionId(state, "old", "new");

    expect(after.pendingHostKeyPrompt?.sessionId).toBe("new");
    expect(after.queuedHostKeyPrompts[0]?.sessionId).toBe("new");
  });
});
