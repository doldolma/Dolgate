import { describe, expect, it, vi } from "vitest";
import {
  collectHopSecretsToPersist,
  findHostNeedingPassword,
  jumpHostRejectingAuth,
} from "./connect-credentials";

const bastion = { id: "bastion", kind: "ssh", label: "Bastion", hostname: "b", port: 22, username: "jump", authType: "password" };
const middle = { id: "middle", kind: "ssh", label: "Middle", hostname: "m", port: 22, username: "hop", authType: "privateKey" };
const target = { id: "target", kind: "ssh", label: "Target", hostname: "t", port: 22, username: "app", authType: "password", jumpHostIds: ["bastion"] };

/** stored 에 든 호스트는 저장된 비밀번호가 있다. 이번에 넣은 값이 있으면 그것이 먼저다. */
function createContext(hosts: object[], stored: Record<string, string> = {}) {
  const byId = new Map(hosts.map((host) => [(host as { id: string }).id, host]));
  return {
    vaults: {
      getHostInSameVault: vi.fn((_hostId: string, otherId: string) => byId.get(otherId) ?? null),
    },
    resolveSshAuth: vi.fn(async (host: { id: string; username: string; authType: string }, provided?: { password?: string; username?: string }) => ({
      username: provided?.username ?? host.username,
      authType: host.authType,
      secrets: provided?.password ? { password: provided.password } : stored[host.id] ? { password: stored[host.id] } : {},
      shouldPersistHostSecret: Boolean(provided?.password),
      typedUsername: provided?.username ?? null,
    })),
  } as never;
}

describe("findHostNeedingPassword", () => {
  // 코어는 대상의 인증을 먼저 만들어 대상부터 물었다 — 체인 순서대로 베스천을 먼저 찾는다.
  it("finds the jump host first when neither hop has a password", async () => {
    const ctx = createContext([bastion, target]);
    await expect(findHostNeedingPassword(ctx, target as never)).resolves.toBe("bastion");
  });

  it("moves on to the target once this attempt carries the jump host's value", async () => {
    const ctx = createContext([bastion, target]);
    await expect(
      findHostNeedingPassword(ctx, target as never, undefined, { bastion: { password: "jump-pw" } }),
    ).resolves.toBe("target");
    await expect(
      findHostNeedingPassword(ctx, target as never, { password: "app-pw" }, { bastion: { password: "jump-pw" } }),
    ).resolves.toBeNull();
  });

  it("is satisfied by stored values (my credentials, the team's, saved)", async () => {
    const ctx = createContext([bastion, target], { bastion: "stored", target: "stored" });
    await expect(findHostNeedingPassword(ctx, target as never)).resolves.toBeNull();
  });

  // 키 방식 홉은 "비밀번호 없음"이 아니다 — 묻지 않고 지금처럼 코어에 맡긴다.
  it("leaves key-based hops alone", async () => {
    const chained = { ...target, jumpHostIds: ["middle"] };
    const ctx = createContext([middle, chained], { target: "stored" });
    await expect(findHostNeedingPassword(ctx, chained as never)).resolves.toBeNull();
  });

  it("does not judge a broken chain — the connection reports why", async () => {
    const ctx = createContext([target]);
    await expect(findHostNeedingPassword(ctx, target as never)).resolves.toBeNull();
  });
});

describe("collectHopSecretsToPersist", () => {
  it("keeps the values typed for this host's jump hosts only", async () => {
    const ctx = createContext([bastion, target]);
    await expect(
      collectHopSecretsToPersist(ctx, target as never, {
        bastion: { password: "jump-pw", username: "ops" },
        stranger: { password: "x" },
      }),
    ).resolves.toEqual([{ hostId: "bastion", label: "Bastion", secrets: { password: "jump-pw" }, username: "ops" }]);
    await expect(collectHopSecretsToPersist(ctx, target as never)).resolves.toEqual([]);
  });
});

describe("jumpHostRejectingAuth", () => {
  const withDepth = (message: string, jumpDepth: number) => Object.assign(new Error(message), { jumpDepth });

  it("names the jump host whose authentication failed", () => {
    const ctx = createContext([bastion, target]);
    const error = withDepth("jump host: ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password]", 1);
    expect(jumpHostRejectingAuth(ctx, target as never, error)).toMatchObject({ id: "bastion" });
  });

  // 깊이는 대상에서 거꾸로 센다 — 두 홉 체인에서 2 는 첫 홉(클라이언트가 직접 붙는 홉)이다.
  it("counts the depth back from the target in a two-hop chain", () => {
    const first = { ...bastion, id: "first", label: "First" };
    const last = { ...bastion, id: "last", label: "Last" };
    const twoHop = { ...target, jumpHostIds: ["first", "last"] };
    const ctx = createContext([first, last, twoHop]);
    const rejected = "jump host: jump host: ssh: unable to authenticate, attempted methods [none password]";
    expect(jumpHostRejectingAuth(ctx, twoHop as never, withDepth(rejected, 2))).toMatchObject({ id: "first" });
    expect(jumpHostRejectingAuth(ctx, twoHop as never, withDepth(rejected, 1))).toMatchObject({ id: "last" });
  });

  it("leaves the target's own failures and network failures alone", () => {
    const ctx = createContext([bastion, target]);
    expect(jumpHostRejectingAuth(ctx, target as never, new Error("ssh: unable to authenticate"))).toBeNull();
    expect(jumpHostRejectingAuth(ctx, target as never, withDepth("jump host: dial failed: i/o timeout", 1))).toBeNull();
  });
});
