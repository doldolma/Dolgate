import { afterEach, describe, expect, it, vi } from "vitest";

// 팀 API 는 개인 동기화와 같은 규칙으로 토큰을 갱신하고 볼트 세대 거절을 올린다. 다른 실패는 서버의
// code 를 담아 던진다 — 팀 동기화가 "팀에서 빠짐"을 그것으로 가른다.

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp"), getVersion: vi.fn(() => "1.9.14-test"), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const { TeamApi, TeamApiError } = await import("./team-api");
const { SyncAuthenticationError, SyncVaultDekMismatchError } = await import("./sync-service");

function lease() {
  return {
    serverUrl: "https://sync.example.com",
    accessToken: "access-old",
    vaultEpoch: 5,
    signal: new AbortController().signal,
    isActive: () => true,
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TeamApi", () => {
  it("refreshes an expired token once and retries with the new one", async () => {
    const auth = {
      refreshSession: vi.fn(async () => ({ status: "authenticated" })),
      getAccessToken: () => "access-new",
      getClientIdentificationHeaders: () => ({ "X-Dolgate-Client": "desktop" }),
    };
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init: RequestInit) => {
        const authorization = new Headers(init.headers).get("Authorization") ?? "";
        seen.push(authorization);
        return authorization === "Bearer access-new"
          ? json({ teams: [{ id: "t1", name: "Acme", role: "owner", wrappedTeamDek: "", dataFloor: 0 }] }, 200)
          : json({ error: "token is expired" }, 401);
      }),
    );

    const teams = await new TeamApi(auth).listTeams(lease());

    expect(seen).toEqual(["Bearer access-old", "Bearer access-new"]);
    expect(auth.refreshSession).toHaveBeenCalledTimes(1);
    // 사본을 아직 안 올린 멤버는 빈 문자열로 온다.
    expect(teams).toEqual([expect.objectContaining({ id: "t1", role: "owner", wrappedTeamDek: null })]);
  });

  it("gives up as signed out when the refresh fails", async () => {
    const auth = {
      refreshSession: vi.fn(async () => ({ status: "unauthenticated" })),
      getAccessToken: () => "access-new",
      getClientIdentificationHeaders: () => ({}),
    };
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "token is expired" }, 401)));

    await expect(new TeamApi(auth).listTeams(lease())).rejects.toBeInstanceOf(SyncAuthenticationError);
  });

  it("takes an owners-only refusal as a team error, not as a sign-in problem", async () => {
    const auth = {
      refreshSession: vi.fn(async () => ({ status: "authenticated" })),
      getAccessToken: () => "access-new",
      getClientIdentificationHeaders: () => ({}),
    };
    const api = new TeamApi(auth);
    const ownersOnly = () => json({ error: "owners only", code: "team_owner_only" }, 403);
    const fetchOwnersOnly = vi.fn(async () => ownersOnly());
    vi.stubGlobal("fetch", fetchOwnersOnly);

    const refused = await api.renameTeam(lease(), "t1", "Renamed").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TeamApiError);
    expect(refused).toMatchObject({ status: 403, code: "team_owner_only", message: "팀 소유자만 할 수 있습니다." });
    expect(auth.refreshSession).not.toHaveBeenCalled();
    expect(fetchOwnersOnly).toHaveBeenCalledTimes(1);

    // 토큰이 만료돼 갱신한 뒤에 받은 거절도 같다.
    const responses = [json({ error: "token is expired" }, 401), ownersOnly()];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));
    await expect(api.renameTeam(lease(), "t1", "Renamed")).rejects.toMatchObject({
      name: "TeamApiError",
      code: "team_owner_only",
    });
    expect(auth.refreshSession).toHaveBeenCalledTimes(1);
  });

  it("keeps the server's code, and reports a vault epoch rejection like personal sync does", async () => {
    const auth = {
      refreshSession: vi.fn(),
      getAccessToken: () => "access-old",
      getClientIdentificationHeaders: () => ({}),
    };
    const api = new TeamApi(auth);

    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "팀을 찾을 수 없습니다.", code: "team_not_found" }, 404)));
    const notFound = await api.getRecords(lease(), "t1", null).catch((error: unknown) => error);
    expect(notFound).toBeInstanceOf(TeamApiError);
    expect(notFound).toMatchObject({ status: 404, code: "team_not_found", message: "팀을 찾을 수 없습니다." });

    let epochHeader: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init: RequestInit) => {
        epochHeader = new Headers(init.headers).get("X-Dolgate-Vault-Epoch");
        return json({ error: "동기화 암호가 초기화되었습니다.", code: "vault_dek_mismatch" }, 409);
      }),
    );
    await expect(api.putPrivate(lease(), "t1", {})).rejects.toBeInstanceOf(SyncVaultDekMismatchError);
    expect(epochHeader).toBe("5");
    expect(auth.refreshSession).not.toHaveBeenCalled();
  });

  it("words a team error it knows in the app's language and keeps the server's text otherwise", async () => {
    const api = new TeamApi({
      refreshSession: vi.fn(),
      getAccessToken: () => "access-old",
      getClientIdentificationHeaders: () => ({}),
    });
    const failWith = (body: unknown, status: number) => vi.stubGlobal("fetch", vi.fn(async () => json(body, status)));

    failWith({ error: "transfer first", code: "team_owner_must_transfer" }, 409);
    await expect(api.getRecords(lease(), "t1", null)).rejects.toMatchObject({
      code: "team_owner_must_transfer",
      message: "다른 멤버가 남아 있으면 소유권을 넘긴 뒤에 나갈 수 있습니다.",
    });

    // 더 새 서버의 code 나 code 없는 실패는 서버가 쓴 글 그대로다.
    failWith({ error: "새 서버의 규칙입니다.", code: "team_future_rule" }, 409);
    await expect(api.getRecords(lease(), "t1", null)).rejects.toMatchObject({
      code: "team_future_rule",
      message: "새 서버의 규칙입니다.",
    });
    failWith({ error: "code 없는 실패입니다." }, 400);
    await expect(api.getRecords(lease(), "t1", null)).rejects.toMatchObject({ code: null, message: "code 없는 실패입니다." });
  });
});
