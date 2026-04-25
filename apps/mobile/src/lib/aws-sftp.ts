import { Buffer } from "buffer";
import type {
  AwsSftpCreateSessionRequest,
  AwsSftpDirectoryListResponse,
  AwsSftpHostKeyChallengeResponse,
  AwsSftpReadChunkResponse,
  AwsSftpSessionResponse,
} from "@dolssh/shared-core";
import { normalizeServerUrl } from "@dolssh/shared-core";
import { ApiError, type MobileServerPublicKeyInfo } from "./mobile";

export class AwsSftpHostKeyChallengeError extends Error {
  constructor(
    readonly code: AwsSftpHostKeyChallengeResponse["code"],
    readonly info: MobileServerPublicKeyInfo,
    message: string,
  ) {
    super(message);
    this.name = "AwsSftpHostKeyChallengeError";
  }
}

interface AwsSftpRequestOptions {
  serverUrl: string;
  accessToken: string;
}

interface AwsSftpConnectInput extends AwsSftpRequestOptions {
  payload: AwsSftpCreateSessionRequest;
}

async function parseErrorResponse(response: Response): Promise<string> {
  const text = await response.text();
  if (!text.trim()) {
    return `HTTP ${response.status}`;
  }
  try {
    const payload = JSON.parse(text) as { error?: string; message?: string };
    return payload.error || payload.message || text;
  } catch {
    return text;
  }
}

async function fetchJson<T>(
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  if (response.status === 409) {
    const text = await response.text();
    const payload = JSON.parse(text) as AwsSftpHostKeyChallengeResponse;
    if (
      (payload.code === "host_key_required" ||
        payload.code === "host_key_mismatch") &&
      payload.info
    ) {
      throw new AwsSftpHostKeyChallengeError(
        payload.code,
        {
          host: payload.info.host,
          port: payload.info.port,
          remoteIp: payload.info.remoteIp ?? undefined,
          algorithm: payload.info.algorithm,
          fingerprintSha256: payload.info.fingerprintSha256,
          keyBase64: payload.info.keyBase64,
        },
        payload.message,
      );
    }
    throw new ApiError(payload.message || text || "HTTP 409", 409);
  }
  if (!response.ok) {
    throw new ApiError(await parseErrorResponse(response), response.status);
  }
  return (await response.json()) as T;
}

async function fetchEmpty(url: string, init: RequestInit): Promise<void> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new ApiError(await parseErrorResponse(response), response.status);
  }
}

function buildAwsSftpUrl(serverUrl: string, path: string): string {
  return new URL(path, normalizeServerUrl(serverUrl)).toString();
}

function authHeaders(accessToken: string, json = false): Record<string, string> {
  return json
    ? {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      }
    : {
        authorization: `Bearer ${accessToken}`,
      };
}

export class AwsSftpApiConnection {
  constructor(
    private readonly options: AwsSftpRequestOptions,
    readonly sessionId: string,
    readonly connectedAt: string,
  ) {}

  async listDirectory(path: string): Promise<AwsSftpDirectoryListResponse> {
    const url = new URL(
      buildAwsSftpUrl(
        this.options.serverUrl,
        `/api/aws-sftp/sessions/${encodeURIComponent(this.sessionId)}/list`,
      ),
    );
    url.searchParams.set("path", path);
    return fetchJson<AwsSftpDirectoryListResponse>(url.toString(), {
      headers: authHeaders(this.options.accessToken),
    });
  }

  async readFileChunk(
    path: string,
    offset: number,
    length: number,
  ): Promise<{ bytes: ArrayBuffer; bytesRead: number; eof: boolean }> {
    const response = await fetchJson<AwsSftpReadChunkResponse>(
      buildAwsSftpUrl(
        this.options.serverUrl,
        `/api/aws-sftp/sessions/${encodeURIComponent(this.sessionId)}/read`,
      ),
      {
        method: "POST",
        headers: authHeaders(this.options.accessToken, true),
        body: JSON.stringify({ path, offset, length }),
      },
    );
    const bytes = Buffer.from(response.bytesBase64, "base64");
    return {
      bytes: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ),
      bytesRead: response.bytesRead,
      eof: response.eof,
    };
  }

  async writeFileChunk(
    path: string,
    offset: number,
    data: ArrayBuffer,
  ): Promise<void> {
    const bytes = Buffer.from(new Uint8Array(data));
    await fetchEmpty(
      buildAwsSftpUrl(
        this.options.serverUrl,
        `/api/aws-sftp/sessions/${encodeURIComponent(this.sessionId)}/write`,
      ),
      {
        method: "POST",
        headers: authHeaders(this.options.accessToken, true),
        body: JSON.stringify({
          path,
          offset,
          bytesBase64: bytes.toString("base64"),
        }),
      },
    );
  }

  async mkdir(path: string): Promise<void> {
    await this.postPath("mkdir", path);
  }

  async rename(sourcePath: string, targetPath: string): Promise<void> {
    await fetchEmpty(
      buildAwsSftpUrl(
        this.options.serverUrl,
        `/api/aws-sftp/sessions/${encodeURIComponent(this.sessionId)}/rename`,
      ),
      {
        method: "POST",
        headers: authHeaders(this.options.accessToken, true),
        body: JSON.stringify({ sourcePath, targetPath }),
      },
    );
  }

  async chmod(path: string, permissions: number): Promise<void> {
    await fetchEmpty(
      buildAwsSftpUrl(
        this.options.serverUrl,
        `/api/aws-sftp/sessions/${encodeURIComponent(this.sessionId)}/chmod`,
      ),
      {
        method: "POST",
        headers: authHeaders(this.options.accessToken, true),
        body: JSON.stringify({ path, permissions }),
      },
    );
  }

  async delete(path: string): Promise<void> {
    await this.postPath("delete", path);
  }

  async close(): Promise<void> {
    await fetchEmpty(
      buildAwsSftpUrl(
        this.options.serverUrl,
        `/api/aws-sftp/sessions/${encodeURIComponent(this.sessionId)}`,
      ),
      {
        method: "DELETE",
        headers: authHeaders(this.options.accessToken),
      },
    );
  }

  private async postPath(action: "mkdir" | "delete", path: string): Promise<void> {
    await fetchEmpty(
      buildAwsSftpUrl(
        this.options.serverUrl,
        `/api/aws-sftp/sessions/${encodeURIComponent(this.sessionId)}/${action}`,
      ),
      {
        method: "POST",
        headers: authHeaders(this.options.accessToken, true),
        body: JSON.stringify({ path }),
      },
    );
  }
}

export async function connectAwsSftp(
  input: AwsSftpConnectInput,
): Promise<AwsSftpApiConnection> {
  const response = await fetchJson<AwsSftpSessionResponse>(
    buildAwsSftpUrl(input.serverUrl, "/api/aws-sftp/sessions"),
    {
      method: "POST",
      headers: authHeaders(input.accessToken, true),
      body: JSON.stringify(input.payload),
    },
  );
  return new AwsSftpApiConnection(
    {
      serverUrl: input.serverUrl,
      accessToken: input.accessToken,
    },
    response.sessionId,
    response.connectedAt,
  );
}
