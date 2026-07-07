import { afterAll, describe, expect, it, vi } from "vitest";
import { registerCodexMcpTools, stopCodexMcpServer } from "./codex-mcp-server";
import type { AiToolDef } from "../../shared/ai";

const TOOL_DEF: AiToolDef = {
  name: "inspect_command",
  description: "read-only inspect",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

// 실제 MCP 클라이언트(codex)가 보내는 것과 같은 JSON-RPC POST. stateless 서버라
// 요청마다 독립적으로 처리된다(Accept 에 json+sse 둘 다 요구됨).
async function mcpPost(url: string, token: string | null, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  },
};

afterAll(() => {
  stopCodexMcpServer();
});

describe("codex MCP server", () => {
  it("serves tools/list and tools/call for a registered binding (bearer auth)", async () => {
    const invoke = vi.fn().mockResolvedValue({ content: "exit code: 0\nstdout:\nok" });
    const registration = await registerCodexMcpTools({ defs: [TOOL_DEF], invoke });
    try {
      const init = await mcpPost(registration.url, registration.token, INITIALIZE);
      expect(init.status).toBe(200);

      const listResponse = await mcpPost(registration.url, registration.token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as {
        result: { tools: Array<{ name: string; inputSchema: unknown }> };
      };
      expect(listBody.result.tools).toHaveLength(1);
      expect(listBody.result.tools[0].name).toBe("inspect_command");
      expect(listBody.result.tools[0].inputSchema).toEqual(TOOL_DEF.parameters);

      const callResponse = await mcpPost(registration.url, registration.token, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "inspect_command", arguments: { command: "df -h" } },
      });
      expect(callResponse.status).toBe(200);
      const callBody = (await callResponse.json()) as {
        result: { content: Array<{ type: string; text: string }>; isError?: boolean };
      };
      expect(invoke).toHaveBeenCalledWith("inspect_command", { command: "df -h" });
      expect(callBody.result.content[0].text).toContain("exit code: 0");
      expect(callBody.result.isError).toBeUndefined();
    } finally {
      registration.dispose();
    }
  });

  it("marks executor failures with isError", async () => {
    const invoke = vi.fn().mockResolvedValue({ content: "error: nope", isError: true });
    const registration = await registerCodexMcpTools({ defs: [TOOL_DEF], invoke });
    try {
      const callResponse = await mcpPost(registration.url, registration.token, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "inspect_command", arguments: {} },
      });
      const body = (await callResponse.json()) as { result: { isError?: boolean } };
      expect(body.result.isError).toBe(true);
    } finally {
      registration.dispose();
    }
  });

  it("rejects missing/wrong tokens and disposed registrations with 401", async () => {
    const registration = await registerCodexMcpTools({
      defs: [TOOL_DEF],
      invoke: vi.fn().mockResolvedValue({ content: "x" }),
    });

    expect((await mcpPost(registration.url, null, INITIALIZE)).status).toBe(401);
    expect((await mcpPost(registration.url, "wrong-token", INITIALIZE)).status).toBe(401);
    expect((await mcpPost(registration.url, registration.token, INITIALIZE)).status).toBe(200);

    registration.dispose();
    expect((await mcpPost(registration.url, registration.token, INITIALIZE)).status).toBe(401);
  });

  it("isolates concurrent registrations by token", async () => {
    const invokeA = vi.fn().mockResolvedValue({ content: "A" });
    const invokeB = vi.fn().mockResolvedValue({ content: "B" });
    const a = await registerCodexMcpTools({ defs: [TOOL_DEF], invoke: invokeA });
    const b = await registerCodexMcpTools({ defs: [TOOL_DEF], invoke: invokeB });
    try {
      const responseB = await mcpPost(b.url, b.token, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "inspect_command", arguments: {} },
      });
      const body = (await responseB.json()) as { result: { content: Array<{ text: string }> } };
      expect(body.result.content[0].text).toBe("B");
      expect(invokeA).not.toHaveBeenCalled();
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});
