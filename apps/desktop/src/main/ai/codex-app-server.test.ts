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
  stdin = {
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
  };

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
});
