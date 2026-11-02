import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => "/mock/app",
    getPath: () => "/mock/user-data",
    getVersion: () => "0.0.0-test",
    once: vi.fn(),
  },
}));

import {
  CodexAppServerClient,
  codexAuthStatus,
  codexListModels,
  codexLoginStart,
  codexLogout,
  codexUsage,
} from "./codex-app-server";

// stdin 에 쓰인 JSON-RPC 요청을 파싱해 응답을 stdout 으로 돌려주는 가짜 codex app-server.
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
  requests: Array<{ method: string; id: number; params?: unknown }> = [];
  stdin = Object.assign(new EventEmitter(), {
    write: (line: string) => {
      const payload = JSON.parse(line) as { method: string; id: number; params?: unknown };
      this.requests.push(payload);
      const responder = this.responders[payload.method];
      if (responder) {
        const response = responder(payload);
        this.stdout.write(`${JSON.stringify(response)}\n`);
      }
      return true;
    },
  });

  constructor(
    private readonly responders: Record<
      string,
      (request: { method: string; id: number; params?: unknown }) => unknown
    >,
  ) {
    super();
  }
}

function makeClient(
  responders: Record<string, (request: { method: string; id: number; params?: unknown }) => unknown>,
): { client: CodexAppServerClient; child: FakeChild } {
  const child = new FakeChild({
    initialize: (request) => ({ id: request.id, result: {} }),
    ...responders,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = new CodexAppServerClient(() => child as any);
  return { client, child };
}

describe("CodexAppServerClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("performs the initialize handshake before the first request", async () => {
    const { client, child } = makeClient({
      "account/read": (request) => ({ id: request.id, result: { account: null } }),
    });
    await client.request("account/read", { refreshToken: true });
    expect(child.requests.map((request) => request.method)).toEqual(["initialize", "account/read"]);
    expect(child.requests[0].params).toMatchObject({ clientInfo: { name: "dolgate" } });
  });

  it("rejects the request when the server returns an error", async () => {
    const { client } = makeClient({
      "account/logout": (request) => ({ id: request.id, error: { code: 1, message: "nope" } }),
    });
    await expect(client.request("account/logout")).rejects.toThrow("nope");
  });

  it("rejects pending requests when the process exits and restarts on the next call", async () => {
    let spawnCount = 0;
    const children: FakeChild[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new CodexAppServerClient((): any => {
      spawnCount += 1;
      const child = new FakeChild({
        initialize: (request) => ({ id: request.id, result: {} }),
        // account/read 는 응답하지 않는다(pending 상태 유지) — exit 로 reject 되는지 확인.
        ...(spawnCount === 2
          ? { "account/read": (request) => ({ id: request.id, result: { account: null } }) }
          : {}),
      });
      children.push(child);
      return child;
    });

    const pending = client.request("account/read");
    // 첫 프로세스가 죽으면 pending 이 reject 된다.
    await new Promise((resolve) => setImmediate(resolve));
    children[0].emit("exit", 1, null);
    await expect(pending).rejects.toThrow("종료");

    // 다음 요청은 새 프로세스를 띄워 성공한다.
    await client.request("account/read");
    expect(spawnCount).toBe(2);
  });
});

describe("codex auth helpers", () => {
  it("codexLoginStart returns the browser auth url", async () => {
    const { client } = makeClient({
      "account/login/start": (request) => ({
        id: request.id,
        result: { type: "chatgpt", loginId: "L1", authUrl: "https://auth.example/login" },
      }),
    });
    await expect(codexLoginStart(client)).resolves.toEqual({
      loginId: "L1",
      authUrl: "https://auth.example/login",
    });
  });

  it("codexLoginStart throws when the server returns a non-browser response", async () => {
    const { client } = makeClient({
      "account/login/start": (request) => ({ id: request.id, result: { type: "apiKey" } }),
    });
    await expect(codexLoginStart(client)).rejects.toThrow("브라우저 로그인 URL");
  });

  it("codexAuthStatus summarizes the account response", async () => {
    const { client } = makeClient({
      "account/read": (request) => ({
        id: request.id,
        result: { account: { type: "chatgpt", email: "dev@example.com", planType: "pro" } },
      }),
    });
    await expect(codexAuthStatus(client)).resolves.toEqual({
      authenticated: true,
      authMode: "chatgpt",
      email: "dev@example.com",
      planType: "pro",
    });
  });

  it("codexAuthStatus reports unauthenticated when account is null", async () => {
    const { client } = makeClient({
      "account/read": (request) => ({ id: request.id, result: { account: null } }),
    });
    await expect(codexAuthStatus(client)).resolves.toMatchObject({
      authenticated: false,
      email: null,
    });
  });

  it("codexLogout resolves on success", async () => {
    const { client } = makeClient({
      "account/logout": (request) => ({ id: request.id, result: {} }),
    });
    await expect(codexLogout(client)).resolves.toBeUndefined();
  });

  it("codexUsage normalizes the rate-limit windows", async () => {
    const { client } = makeClient({
      "account/rateLimits/read": (request) => ({
        id: request.id,
        result: {
          rateLimits: {
            planType: "plus",
            primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1783450934 },
            secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1784037734 },
          },
        },
      }),
    });
    await expect(codexUsage(client)).resolves.toEqual({
      planType: "plus",
      primary: { usedPercent: 3, windowMinutes: 300, resetsAt: 1783450934 },
      secondary: { usedPercent: 0, windowMinutes: 10080, resetsAt: 1784037734 },
    });
  });

  it("codexUsage tolerates missing rate limits (nulls, not throw)", async () => {
    const { client } = makeClient({
      "account/rateLimits/read": (request) => ({ id: request.id, result: {} }),
    });
    await expect(codexUsage(client)).resolves.toEqual({
      planType: null,
      primary: null,
      secondary: null,
    });
  });

  it("codexListModels keeps server order, skips hidden entries, and falls back per field", async () => {
    const { client } = makeClient({
      "model/list": (request) => ({
        id: request.id,
        result: {
          data: [
            {
              id: "gpt-5.6-sol",
              model: "gpt-5.6-sol",
              displayName: "GPT-5.6-Sol",
              description: "Latest frontier agentic coding model.",
              hidden: false,
              isDefault: true,
            },
            {
              id: "internal-preview",
              model: "internal-preview",
              displayName: "Internal",
              hidden: true,
              isDefault: false,
            },
            // displayName/description 없는 항목 — id 로 표시하고 설명은 null.
            { model: "gpt-5.5" },
          ],
        },
      }),
    });
    await expect(codexListModels(client)).resolves.toEqual([
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        description: "Latest frontier agentic coding model.",
        isDefault: true,
      },
      { id: "gpt-5.5", displayName: "gpt-5.5", description: null, isDefault: false },
    ]);
  });

  it("codexListModels tolerates an empty/absent list", async () => {
    const { client } = makeClient({
      "model/list": (request) => ({ id: request.id, result: {} }),
    });
    await expect(codexListModels(client)).resolves.toEqual([]);
  });
});

// 서버가 죽은 직후의 틈 — 메인이 그 죽음(exit)을 처리하기 전에는 stdin 이 아직 쓸 수 있는 것으로 보여 요청이 써지고, 그 쓰기가
// EPIPE 로 실패한다. 받지 않으면 잡히지 않은 예외가 되어 Electron 기본 알림 창이 메인을 멈췄다(실제 앱, 2026-11-02 — ssh-core 가
// 죽은 직후 RDP 통로 정리가 쓰다가).
describe("a write that fails because the app server just died", () => {
  it("is noted and swallowed", async () => {
    const { client, child } = makeClient({});
    await client.request("initialize").catch(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() =>
      child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EPIPE"));
    warn.mockRestore();
  });
});
