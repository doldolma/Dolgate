import { BrowserWindow, app, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuthSession } from '@dolssh/shared';
import type { AuthState } from '@dolssh/shared';
import { ipcChannels } from '../common/ipc-channels';
import type { DesktopConfigService } from './app-config';
import { SecretStore } from './secret-store';

const REFRESH_TOKEN_ACCOUNT = 'auth:refresh-token';
const LOOPBACK_CALLBACK_HOST = '127.0.0.1';

function createDefaultAuthState(): AuthState {
  return {
    status: 'loading',
    session: null,
    errorMessage: null
  };
}

function isAuthSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.syncServerTime === 'string' && candidate.tokens != null && candidate.user != null && candidate.vaultBootstrap != null;
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

async function toApiErrorMessage(response: Response, fallback: string): Promise<string> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = (await response.text()).trim();
  const looksLikeHtml =
    contentType.includes('text/html') ||
    text.startsWith('<!DOCTYPE html') ||
    text.startsWith('<html') ||
    text.includes('<body>');

  if (looksLikeHtml) {
    return `${fallback} 서버가 API 응답 대신 HTML 페이지를 반환했습니다. 배포 주소 또는 리버스 프록시 설정을 확인해 주세요. (${response.status})`;
  }

  return text || `${fallback} (${response.status})`;
}

export class AuthService {
  private readonly windows = new Set<BrowserWindow>();
  private readonly processedExchangeCodes = new Set<string>();
  private state: AuthState = createDefaultAuthState();
  private refreshTimer: NodeJS.Timeout | null = null;
  private pendingBrowserLoginState: string | null = null;
  private exchangeInFlightCode: string | null = null;
  private onSessionInvalidated: (() => Promise<void> | void) | null = null;
  private loopbackCallbackServer: Server | null = null;

  constructor(
    private readonly secretStore: SecretStore,
    private readonly configService: DesktopConfigService
  ) {}

  registerWindow(window: BrowserWindow): void {
    this.windows.add(window);
    window.on('closed', () => {
      this.windows.delete(window);
    });
  }

  getServerUrl(): string {
    return this.configService.getConfig().sync.serverUrl;
  }

  getDesktopClientId(): string {
    return this.configService.getConfig().sync.desktopClientId;
  }

  getRedirectUri(): string {
    return this.configService.getConfig().sync.redirectUri;
  }

  getState(): AuthState {
    return this.state;
  }

  setOnSessionInvalidated(callback: () => Promise<void> | void): void {
    this.onSessionInvalidated = callback;
  }

  async bootstrap(): Promise<AuthState> {
    if (this.state.status === 'authenticated') {
      return this.state;
    }

    this.patchState({
      status: 'loading',
      errorMessage: null
    });

    const refreshToken = await this.secretStore.load(REFRESH_TOKEN_ACCOUNT);
    if (!refreshToken) {
      this.patchState({
        status: 'unauthenticated',
        session: null,
        errorMessage: null
      });
      return this.state;
    }

    try {
      const session = await this.requestSession('/auth/refresh', {
        refreshToken
      });
      await this.persistSession(session);
      return this.state;
    } catch (error) {
      await this.clearSession({
        status: 'unauthenticated',
        errorMessage: toErrorMessage(error, '세션을 복구하지 못했습니다.')
      });
      return this.state;
    }
  }

  async beginBrowserLogin(): Promise<void> {
    const browserState = randomUUID();
    this.pendingBrowserLoginState = browserState;
    this.patchState({
      status: 'authenticating',
      errorMessage: null
    });

    const redirectUri = await this.prepareBrowserRedirectUri();

    const loginUrl = new URL('/login', this.getServerUrl());
    loginUrl.searchParams.set('client', this.getDesktopClientId());
    loginUrl.searchParams.set('redirect_uri', redirectUri);
    loginUrl.searchParams.set('state', browserState);

    try {
      await shell.openExternal(loginUrl.toString());
    } catch (error) {
      await this.closeLoopbackCallbackServer();
      throw error;
    }
  }

  async handleCallbackUrl(rawUrl: string): Promise<void> {
    const callbackUrl = new URL(rawUrl);
    const code = callbackUrl.searchParams.get('code');
    const state = callbackUrl.searchParams.get('state');
    if (!code) {
      throw new Error('로그인 콜백에 code가 없습니다.');
    }
    if (this.processedExchangeCodes.has(code) || this.exchangeInFlightCode === code) {
      return;
    }
    if (this.pendingBrowserLoginState && state && this.pendingBrowserLoginState !== state) {
      throw new Error('로그인 상태 값이 일치하지 않습니다.');
    }
    this.pendingBrowserLoginState = null;
    this.exchangeInFlightCode = code;

    try {
      const session = await this.requestSession('/auth/exchange', {
        code
      });
      this.processedExchangeCodes.add(code);
      await this.persistSession(session);
    } finally {
      if (this.exchangeInFlightCode === code) {
        this.exchangeInFlightCode = null;
      }
    }
  }

  async logout(): Promise<void> {
    const refreshToken = await this.secretStore.load(REFRESH_TOKEN_ACCOUNT);
    if (refreshToken) {
      await fetch(new URL('/auth/logout', this.getServerUrl()), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          refreshToken
        })
      }).catch(() => undefined);
    }
    await this.clearSession({
      status: 'unauthenticated',
      errorMessage: null
    });
  }

  async forceUnauthenticated(errorMessage?: string): Promise<void> {
    await this.clearSession({
      status: 'unauthenticated',
      errorMessage: errorMessage ?? null
    });
  }

  getAccessToken(): string {
    if (this.state.status !== 'authenticated' || !this.state.session?.tokens.accessToken) {
      throw new Error('로그인이 필요합니다.');
    }
    return this.state.session.tokens.accessToken;
  }

  getVaultKeyBase64(): string {
    if (this.state.status !== 'authenticated' || !this.state.session?.vaultBootstrap.keyBase64) {
      throw new Error('세션 vault key가 없습니다.');
    }
    return this.state.session.vaultBootstrap.keyBase64;
  }

  private async requestSession(pathname: string, payload: Record<string, unknown>): Promise<AuthSession> {
    const response = await fetch(new URL(pathname, this.getServerUrl()), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(await toApiErrorMessage(response, '인증 요청에 실패했습니다.'));
    }

    const json = (await response.json()) as unknown;
    if (!isAuthSession(json)) {
      throw new Error('인증 응답 형식이 올바르지 않습니다.');
    }
    return json;
  }

  private async persistSession(session: AuthSession): Promise<void> {
    await this.secretStore.save(REFRESH_TOKEN_ACCOUNT, session.tokens.refreshToken);
    this.patchState({
      status: 'authenticated',
      session,
      errorMessage: null
    });
    this.scheduleRefresh(session.tokens.expiresInSeconds);
  }

  private scheduleRefresh(expiresInSeconds: number): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    const delay = Math.max(15_000, (expiresInSeconds - 60) * 1000);
    this.refreshTimer = setTimeout(() => {
      void this.bootstrap();
    }, delay);
  }

  private async clearSession(nextState: Pick<AuthState, 'status' | 'errorMessage'>): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    await this.closeLoopbackCallbackServer();
    await this.secretStore.remove(REFRESH_TOKEN_ACCOUNT).catch(() => undefined);
    this.exchangeInFlightCode = null;
    this.pendingBrowserLoginState = null;
    this.state = {
      status: nextState.status,
      session: null,
      errorMessage: nextState.errorMessage ?? null
    };
    if (this.onSessionInvalidated) {
      await this.onSessionInvalidated();
    }
    this.broadcast(this.state);
  }

  private patchState(patch: Partial<AuthState>): void {
    this.state = {
      ...this.state,
      ...patch
    };
    this.broadcast(this.state);
  }

  private broadcast(state: AuthState): void {
    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.auth.event, state);
      }
    }
  }

  registerProtocolClient(): void {
    if (!app.isPackaged) {
      return;
    }
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('dolssh', process.execPath, [process.argv[1]!]);
      return;
    }
    app.setAsDefaultProtocolClient('dolssh');
  }

  private async prepareBrowserRedirectUri(): Promise<string> {
    return this.startLoopbackCallbackServer();
  }

  private async startLoopbackCallbackServer(): Promise<string> {
    await this.closeLoopbackCallbackServer();

    const server = createServer((request, response) => {
      void this.handleLoopbackCallbackRequest(request.url ?? '/', response);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, LOOPBACK_CALLBACK_HOST, () => {
        server.off('error', reject);
        resolve();
      });
    });

    this.loopbackCallbackServer = server;
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('로컬 로그인 콜백 포트를 열지 못했습니다.');
    }
    return `http://${LOOPBACK_CALLBACK_HOST}:${(address as AddressInfo).port}/auth/callback`;
  }

  private async handleLoopbackCallbackRequest(requestUrl: string, response: ServerResponse): Promise<void> {
    const url = new URL(requestUrl, `http://${LOOPBACK_CALLBACK_HOST}`);
    if (url.pathname !== '/auth/callback') {
      response.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
      });
      response.end('not found');
      return;
    }

    try {
      await this.handleCallbackUrl(url.toString());
      this.focusWindows();
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8'
      });
      response.end(renderLoopbackCallbackPage('로그인이 완료되었습니다.', 'dolssh 앱으로 돌아갑니다. 이 탭은 닫아도 됩니다.'));
    } catch (error) {
      const message = toErrorMessage(error, '브라우저 로그인 교환에 실패했습니다.');
      response.writeHead(500, {
        'Content-Type': 'text/html; charset=utf-8'
      });
      response.end(renderLoopbackCallbackPage('로그인에 실패했습니다.', message));
      await this.forceUnauthenticated(message);
    } finally {
      await this.closeLoopbackCallbackServer();
    }
  }

  private focusWindows(): void {
    for (const window of this.windows) {
      if (window.isDestroyed()) {
        continue;
      }
      if (!window.isVisible()) {
        window.show();
      }
      if (window.isMinimized()) {
        window.restore();
      }
      window.focus();
    }
    app.focus();
  }

  private async closeLoopbackCallbackServer(): Promise<void> {
    const server = this.loopbackCallbackServer;
    this.loopbackCallbackServer = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

function renderLoopbackCallbackPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0f1726; color:#f5f7fb; }
      .wrap { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:40px; }
      .card { width:100%; max-width:420px; background:#162133; border:1px solid rgba(255,255,255,.08); border-radius:24px; box-shadow:0 18px 48px rgba(0,0,0,.35); padding:32px; }
      .eyebrow { letter-spacing:.2em; font-size:12px; text-transform:uppercase; color:#9fb0d3; margin-bottom:10px; }
      h1 { margin:0 0 12px; font-size:34px; line-height:1.08; }
      p { color:#9fb0d3; margin:0; line-height:1.55; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <div class="eyebrow">dolssh</div>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(message)}</p>
      </div>
    </div>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
