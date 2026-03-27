import { randomUUID } from "node:crypto";
import {
  BrowserWindow,
  session as electronSession,
  type Session,
} from "electron";
import type {
  WarpgateConnectionInfo,
  WarpgateImportEvent,
  WarpgateImportStatus,
  WarpgateTargetSummary,
} from "@shared";
import { ipcChannels } from "../common/ipc-channels";
import { SecretStore } from "./secret-store";

const WARPGATE_API_PATH = "/@warpgate/api";
const WARPGATE_IMPORT_PARTITION_PREFIX = "warpgate-import:";
const WARPGATE_IMPORT_POLL_INTERVAL_MS = 1_000;

interface WarpgateTargetApiRecord {
  name?: string;
  kind?: string;
  external_host?: string;
  group?: {
    id?: string;
    name?: string;
  };
}

interface WarpgateInfoResponse {
  username?: string;
  external_host?: string;
  ports?: {
    ssh?: number;
  };
}

interface WarpgateImportAttempt {
  id: string;
  baseUrl: string;
  partition: string;
  authWindow: BrowserWindow;
  status: WarpgateImportStatus | null;
  pollTimer: NodeJS.Timeout | null;
  fetchInFlight: boolean;
}

function normalizeBaseUrl(baseUrl: string): URL {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error("Warpgate 주소를 입력해 주세요.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = new URL(`https://${trimmed}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Warpgate 주소는 http 또는 https여야 합니다.");
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

function buildApiUrl(baseUrl: string, endpointPath: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  const prefix = normalized.pathname === "/" ? "" : normalized.pathname;
  normalized.pathname = `${prefix}${WARPGATE_API_PATH}${endpointPath}`;
  return normalized.toString();
}

function buildOrigin(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.origin;
}

function tokenAccount(baseUrl: string): string {
  return `warpgate-token:${buildOrigin(baseUrl)}`;
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function parseExternalHost(
  value: string | undefined,
  fallbackHost: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallbackHost;
  }

  try {
    return new URL(trimmed).hostname || fallbackHost;
  } catch {
    const withoutBrackets = trimmed.replace(/^\[/, "").replace(/\]$/, "");
    const colonIndex = withoutBrackets.lastIndexOf(":");
    if (
      colonIndex > 0 &&
      withoutBrackets.indexOf(":") === colonIndex
    ) {
      return withoutBrackets.slice(0, colonIndex) || fallbackHost;
    }
    return withoutBrackets || fallbackHost;
  }
}

function normalizeConnectionInfo(
  baseUrl: string,
  info: WarpgateInfoResponse,
): WarpgateConnectionInfo {
  const normalized = normalizeBaseUrl(baseUrl);
  return {
    baseUrl: normalized.toString().replace(/\/$/, ""),
    sshHost: parseExternalHost(info.external_host, normalized.hostname),
    sshPort: info.ports?.ssh ?? 2222,
    username: info.username?.trim() || null,
  };
}

function normalizeTargets(
  targets: WarpgateTargetApiRecord[],
): WarpgateTargetSummary[] {
  return targets
    .filter((target) => target.kind === "Ssh" && typeof target.name === "string")
    .map((target) => ({
      id: target.group?.id ? `${target.group.id}:${target.name!}` : target.name!,
      name: target.name!,
      kind: "ssh" as const,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function requestJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "X-Warpgate-Token": token,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    let message = `Warpgate 요청에 실패했습니다. (${response.status})`;
    try {
      const payload = (await response.json()) as {
        message?: string;
        error?: string;
      };
      message = payload.message ?? payload.error ?? message;
    } catch {
      const body = await response.text().catch(() => "");
      if (body.trim()) {
        message = body.trim();
      }
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

async function responseToErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = (await response.text()).trim();
  const looksLikeHtml =
    contentType.includes("text/html") ||
    text.startsWith("<!DOCTYPE html") ||
    text.startsWith("<html") ||
    text.includes("<body>");

  if (looksLikeHtml) {
    return `${fallback} 서버가 API 응답 대신 HTML 페이지를 반환했습니다. Warpgate 주소를 다시 확인해 주세요. (${response.status})`;
  }

  return text || `${fallback} (${response.status})`;
}

async function requestSessionJson<T>(
  authSession: Session,
  url: string,
  fallback: string,
): Promise<T> {
  const response = await authSession.fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(await responseToErrorMessage(response, fallback));
  }

  return (await response.json()) as T;
}

export class WarpgateService {
  private readonly windows = new Set<BrowserWindow>();
  private readonly attempts = new Map<string, WarpgateImportAttempt>();

  constructor(private readonly secretStore: SecretStore) {}

  registerWindow(window: BrowserWindow): void {
    this.windows.add(window);
    window.on("closed", () => {
      this.windows.delete(window);
    });
  }

  private async persistToken(baseUrl: string, token: string): Promise<void> {
    await this.secretStore.save(tokenAccount(baseUrl), token.trim());
  }

  async getConnectionInfo(
    baseUrl: string,
    token: string,
  ): Promise<WarpgateConnectionInfo> {
    if (!token.trim()) {
      throw new Error("Warpgate API 토큰을 입력해 주세요.");
    }

    const info = await requestJson<WarpgateInfoResponse>(
      buildApiUrl(baseUrl, "/info"),
      token.trim(),
    );
    await this.persistToken(baseUrl, token);
    return normalizeConnectionInfo(baseUrl, info);
  }

  async testConnection(
    baseUrl: string,
    token: string,
  ): Promise<WarpgateConnectionInfo> {
    const connectionInfo = await this.getConnectionInfo(baseUrl, token);
    await requestJson<WarpgateTargetApiRecord[]>(
      buildApiUrl(baseUrl, "/targets"),
      token.trim(),
    );
    return connectionInfo;
  }

  async listSshTargets(
    baseUrl: string,
    token: string,
  ): Promise<WarpgateTargetSummary[]> {
    if (!token.trim()) {
      throw new Error("Warpgate API 토큰을 입력해 주세요.");
    }
    const targets = await requestJson<WarpgateTargetApiRecord[]>(
      buildApiUrl(baseUrl, "/targets"),
      token.trim(),
    );
    await this.persistToken(baseUrl, token);
    return normalizeTargets(targets);
  }

  async startBrowserImport(
    baseUrl: string,
    parentWindow?: BrowserWindow | null,
  ): Promise<{ attemptId: string }> {
    const normalized = normalizeBaseUrl(baseUrl);
    const attemptId = randomUUID();
    const partition = `${WARPGATE_IMPORT_PARTITION_PREFIX}${attemptId}`;
    const modalParent =
      parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined;
    const authWindow = new BrowserWindow({
      width: 960,
      height: 700,
      minWidth: 840,
      minHeight: 620,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#0d141a",
      title: "Warpgate Login",
      parent: modalParent,
      modal: Boolean(modalParent),
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const attempt: WarpgateImportAttempt = {
      id: attemptId,
      baseUrl: normalized.toString().replace(/\/$/, ""),
      partition,
      authWindow,
      status: null,
      pollTimer: null,
      fetchInFlight: false,
    };

    this.attempts.set(attemptId, attempt);

    authWindow.once("ready-to-show", () => {
      if (authWindow.isDestroyed()) {
        return;
      }
      authWindow.show();
      authWindow.focus();
    });

    authWindow.on("closed", () => {
      if (!this.attempts.has(attemptId)) {
        return;
      }
      this.emitAttemptEvent(attempt, {
        status: "cancelled",
        errorMessage: "Warpgate 로그인 창이 닫혔습니다.",
      });
      void this.cleanupAttempt(attemptId, { closeWindow: false });
    });

    this.emitAttemptEvent(attempt, {
      status: "opening-browser",
      errorMessage: null,
    });
    void this.openAndMonitorAttempt(attempt);

    return { attemptId };
  }

  async cancelBrowserImport(attemptId: string): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      return;
    }
    this.emitAttemptEvent(attempt, {
      status: "cancelled",
      errorMessage: "Warpgate 로그인이 취소되었습니다.",
    });
    await this.cleanupAttempt(attemptId);
  }

  private emitAttemptEvent(
    attempt: WarpgateImportAttempt,
    input: Omit<WarpgateImportEvent, "attemptId">,
  ): void {
    const hasPayload =
      input.connectionInfo !== undefined ||
      input.targets !== undefined ||
      input.errorMessage !== undefined;
    if (!hasPayload && attempt.status === input.status) {
      return;
    }
    attempt.status = input.status;
    this.broadcast({
      attemptId: attempt.id,
      ...input,
    });
  }

  private broadcast(event: WarpgateImportEvent): void {
    for (const window of this.windows) {
      if (window.isDestroyed()) {
        continue;
      }
      window.webContents.send(ipcChannels.warpgate.event, event);
    }
  }

  private async openAndMonitorAttempt(
    attempt: WarpgateImportAttempt,
  ): Promise<void> {
    try {
      await attempt.authWindow.loadURL(attempt.baseUrl);
    } catch (error) {
      const activeAttempt = this.attempts.get(attempt.id);
      if (!activeAttempt) {
        return;
      }
      this.emitAttemptEvent(activeAttempt, {
        status: "error",
        errorMessage: toErrorMessage(
          error,
          "Warpgate 로그인 창을 열지 못했습니다.",
        ),
      });
      await this.cleanupAttempt(activeAttempt.id);
      return;
    }

    const activeAttempt = this.attempts.get(attempt.id);
    if (!activeAttempt) {
      return;
    }
    this.emitAttemptEvent(activeAttempt, {
      status: "waiting-for-login",
      errorMessage: null,
    });
    void this.pollAttempt(activeAttempt.id);
  }

  private scheduleNextPoll(attempt: WarpgateImportAttempt): void {
    if (!this.attempts.has(attempt.id)) {
      return;
    }
    if (attempt.pollTimer) {
      clearTimeout(attempt.pollTimer);
    }
    attempt.pollTimer = setTimeout(() => {
      void this.pollAttempt(attempt.id);
    }, WARPGATE_IMPORT_POLL_INTERVAL_MS);
  }

  private async pollAttempt(attemptId: string): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.fetchInFlight) {
      return;
    }

    attempt.fetchInFlight = true;
    try {
      const authSession = electronSession.fromPartition(attempt.partition);
      const targetsResponse = await authSession.fetch(
        buildApiUrl(attempt.baseUrl, "/targets"),
        {
          headers: {
            Accept: "application/json",
          },
        },
      );

      if (targetsResponse.status === 200) {
        this.emitAttemptEvent(attempt, {
          status: "loading-targets",
          errorMessage: null,
        });
        const rawTargets =
          (await targetsResponse.json()) as WarpgateTargetApiRecord[];
        const info = await requestSessionJson<WarpgateInfoResponse>(
          authSession,
          buildApiUrl(attempt.baseUrl, "/info"),
          "Warpgate 연결 정보를 불러오지 못했습니다.",
        );
        this.broadcast({
          attemptId,
          status: "completed",
          connectionInfo: normalizeConnectionInfo(attempt.baseUrl, info),
          targets: normalizeTargets(rawTargets),
          errorMessage: null,
        });
        await this.cleanupAttempt(attemptId);
        return;
      }

      if (targetsResponse.status === 401 || targetsResponse.status === 404) {
        this.scheduleNextPoll(attempt);
        return;
      }

      throw new Error(
        await responseToErrorMessage(
          targetsResponse,
          "Warpgate target 목록을 불러오지 못했습니다.",
        ),
      );
    } catch (error) {
      const activeAttempt = this.attempts.get(attemptId);
      if (!activeAttempt) {
        return;
      }
      this.emitAttemptEvent(activeAttempt, {
        status: "error",
        errorMessage: toErrorMessage(
          error,
          "Warpgate 인증 중 오류가 발생했습니다.",
        ),
      });
      await this.cleanupAttempt(attemptId);
    } finally {
      const activeAttempt = this.attempts.get(attemptId);
      if (activeAttempt) {
        activeAttempt.fetchInFlight = false;
      }
    }
  }

  private async cleanupAttempt(
    attemptId: string,
    options?: { closeWindow?: boolean },
  ): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      return;
    }

    this.attempts.delete(attemptId);
    if (attempt.pollTimer) {
      clearTimeout(attempt.pollTimer);
      attempt.pollTimer = null;
    }

    const closeWindow = options?.closeWindow ?? true;
    if (closeWindow && !attempt.authWindow.isDestroyed()) {
      attempt.authWindow.close();
    }

    const authSession = electronSession.fromPartition(attempt.partition);
    const cleanupTasks: Promise<unknown>[] = [authSession.clearStorageData()];
    if (typeof authSession.clearCache === "function") {
      cleanupTasks.push(authSession.clearCache());
    }
    await Promise.allSettled(cleanupTasks);
  }

  resolveSshEndpoint(baseUrl: string): { host: string; port: number } {
    const normalized = normalizeBaseUrl(baseUrl);
    return {
      host: normalized.hostname,
      port: 2222,
    };
  }
}
