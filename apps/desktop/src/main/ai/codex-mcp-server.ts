import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { AiToolDef } from "../../shared/ai";

// dolssh 도구를 codex 에 노출하는 localhost MCP(streamable HTTP) 서버.
// codex 는 커스텀 function calling 이 없지만 MCP 클라이언트라서, 채팅마다
// 세션 바인딩된 도구 집합을 bearer 토큰으로 등록해 두면 codex 가 tools/call 로
// dolssh 의 executor(승인·redaction 포함)를 그대로 사용한다.
//
// - 127.0.0.1 전용, 랜덤 포트, 채팅(request)마다 1회용 토큰 → 종료 시 즉시 해제.
// - stateless 모드: 요청마다 바인딩으로부터 새 MCP Server 인스턴스를 만들어 처리한다.

export interface CodexMcpToolResult {
  content: string;
  isError?: boolean;
}

export interface CodexMcpBinding {
  defs: AiToolDef[];
  invoke: (name: string, args: Record<string, unknown>) => Promise<CodexMcpToolResult>;
}

export interface CodexMcpRegistration {
  url: string;
  token: string;
  dispose: () => void;
}

function buildMcpServer(binding: CodexMcpBinding): Server {
  const server = new Server({ name: "dolgate", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: binding.defs.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.parameters,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await binding.invoke(request.params.name, args);
    return {
      content: [{ type: "text", text: result.content }],
      ...(result.isError ? { isError: true } : {}),
    };
  });
  return server;
}

class CodexMcpHttpServer {
  private httpServer: http.Server | null = null;
  private startPromise: Promise<number> | null = null;
  private readonly bindings = new Map<string, CodexMcpBinding>();

  async register(binding: CodexMcpBinding): Promise<CodexMcpRegistration> {
    const port = await this.ensureStarted();
    const token = randomBytes(24).toString("hex");
    this.bindings.set(token, binding);
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      token,
      dispose: () => {
        this.bindings.delete(token);
      },
    };
  }

  stop(): void {
    this.httpServer?.close();
    this.httpServer = null;
    this.startPromise = null;
    this.bindings.clear();
  }

  private ensureStarted(): Promise<number> {
    if (!this.startPromise) {
      this.startPromise = new Promise<number>((resolve, reject) => {
        const server = http.createServer((req, res) => {
          void this.handleRequest(req, res);
        });
        server.once("error", (error) => {
          this.httpServer = null;
          this.startPromise = null;
          reject(error);
        });
        server.listen(0, "127.0.0.1", () => {
          this.httpServer = server;
          resolve((server.address() as AddressInfo).port);
        });
      });
    }
    return this.startPromise;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const authorization = req.headers.authorization ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    const binding = token ? this.bindings.get(token) : undefined;
    if (!binding) {
      res.writeHead(401, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "unauthorized" },
          id: null,
        }),
      );
      return;
    }
    // stateless: 요청마다 새 Server/Transport — 바인딩이 바뀌어도 상태 누수가 없다.
    const server = buildMcpServer(binding);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.once("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    }
  }
}

// 앱 전역 공유 인스턴스(첫 codex 채팅 때 listen). 프로세스 종료와 함께 정리된다.
const sharedServer = new CodexMcpHttpServer();

export function registerCodexMcpTools(binding: CodexMcpBinding): Promise<CodexMcpRegistration> {
  return sharedServer.register(binding);
}

export function stopCodexMcpServer(): void {
  sharedServer.stop();
}
