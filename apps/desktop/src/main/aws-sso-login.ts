import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import {
  CreateTokenCommand,
  RegisterClientCommand,
  SSOOIDCClient,
} from "@aws-sdk/client-sso-oidc";
import { t } from './i18n';

// In-app replacement for `aws sso login`: runs the SSO OIDC authorization-code
// flow (PKCE + loopback redirect, the same flow the AWS CLI uses) and writes
// the token cache in the CLI/SDK-compatible layout, so fromIni/fromSSO keep
// resolving credentials without the aws binary.

const AWS_SSO_LOGIN_SCOPES = ["sso:account:access"];
const DEFAULT_SSO_LOGIN_TIMEOUT_MS = 5 * 60_000;
const SSO_CALLBACK_PATH = "/oauth/callback";

export interface AwsSsoLoginInput {
  startUrl: string;
  ssoRegion: string;
  // sso-session name; the token cache file is keyed by it (legacy profiles
  // without a session fall back to the start URL, matching the SDK/CLI).
  sessionName?: string | null;
  // .aws root the cache is written into (…/sso/cache/<sha1>.json).
  awsRootDir: string;
  timeoutMs?: number;
  openExternal: (url: string) => Promise<void>;
  oidc?: AwsSsoOidcApi;
}

export interface AwsSsoLoginResult {
  accessToken: string;
  expiresAt: string;
}

// Thin adapter over the SSO OIDC SDK so tests can stub the network calls.
export interface AwsSsoOidcApi {
  registerClient(input: {
    ssoRegion: string;
    startUrl: string;
    redirectUri: string;
    scopes: string[];
  }): Promise<{
    clientId: string;
    clientSecret: string;
    clientSecretExpiresAt?: number;
  }>;
  createToken(input: {
    ssoRegion: string;
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresInSeconds: number;
  }>;
}

class SdkAwsSsoOidcApi implements AwsSsoOidcApi {
  async registerClient(input: {
    ssoRegion: string;
    startUrl: string;
    redirectUri: string;
    scopes: string[];
  }) {
    const client = new SSOOIDCClient({ region: input.ssoRegion });
    const output = await client.send(
      new RegisterClientCommand({
        clientName: "Dolgate",
        clientType: "public",
        issuerUrl: input.startUrl,
        redirectUris: [input.redirectUri],
        grantTypes: ["authorization_code", "refresh_token"],
        scopes: input.scopes,
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
    const clientId = output.clientId?.trim();
    const clientSecret = output.clientSecret?.trim();
    if (!clientId || !clientSecret) {
      throw new Error(t('ssoLogin.badClientResponse'));
    }
    return {
      clientId,
      clientSecret,
      clientSecretExpiresAt: output.clientSecretExpiresAt,
    };
  }

  async createToken(input: {
    ssoRegion: string;
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }) {
    const client = new SSOOIDCClient({ region: input.ssoRegion });
    const output = await client.send(
      new CreateTokenCommand({
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        grantType: "authorization_code",
        code: input.code,
        redirectUri: input.redirectUri,
        codeVerifier: input.codeVerifier,
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
    const accessToken = output.accessToken?.trim();
    if (!accessToken) {
      throw new Error(t('ssoLogin.badTokenResponse'));
    }
    return {
      accessToken,
      refreshToken: output.refreshToken?.trim() || undefined,
      expiresInSeconds: output.expiresIn ?? 3600,
    };
  }
}

export function buildSsoAuthorizeUrl(input: {
  ssoRegion: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string[];
}): string {
  const endpoint = new URL(`https://oidc.${input.ssoRegion}.amazonaws.com/authorize`);
  endpoint.searchParams.set("response_type", "code");
  endpoint.searchParams.set("client_id", input.clientId);
  endpoint.searchParams.set("redirect_uri", input.redirectUri);
  endpoint.searchParams.set("state", input.state);
  endpoint.searchParams.set("code_challenge_method", "S256");
  endpoint.searchParams.set("code_challenge", input.codeChallenge);
  endpoint.searchParams.set("scopes", (input.scopes ?? AWS_SSO_LOGIN_SCOPES).join(" "));
  return endpoint.toString();
}

// Cache file naming matches the AWS SDK/CLI: sha1 of the sso-session name for
// session-based configs, sha1 of the start URL for legacy ones.
export function resolveSsoCacheFilePath(
  awsRootDir: string,
  cacheKeyId: string,
): string {
  const digest = createHash("sha1").update(cacheKeyId).digest("hex");
  return path.join(awsRootDir, "sso", "cache", `${digest}.json`);
}

interface SsoCallbackResult {
  code: string;
}

function renderCallbackPage(title: string, body: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
<div style="text-align: center;"><h2>${title}</h2><p>${body}</p></div>
</body></html>`;
}

async function waitForSsoCallback(
  server: http.Server,
  expectedState: string,
  timeoutMs: number,
): Promise<SsoCallbackResult> {
  return new Promise<SsoCallbackResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(t('ssoLogin.timeout')));
    }, timeoutMs);
    timeout.unref();

    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== SSO_CALLBACK_PATH) {
        response.writeHead(404).end();
        return;
      }

      const finish = (status: number, page: string) => {
        response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        response.end(page);
      };

      const errorParam = url.searchParams.get("error");
      if (errorParam) {
        const description =
          url.searchParams.get("error_description")?.trim() || errorParam;
        finish(200, renderCallbackPage(t('ssoLogin.loginFailedTitle'), t('ssoLogin.retryInApp')));
        clearTimeout(timeout);
        reject(new Error(description));
        return;
      }

      const code = url.searchParams.get("code")?.trim() ?? "";
      const state = url.searchParams.get("state")?.trim() ?? "";
      if (!code || state !== expectedState) {
        finish(200, renderCallbackPage(t('ssoLogin.loginFailedTitle'), t('ssoLogin.verifyFailedBody')));
        clearTimeout(timeout);
        reject(new Error(t('ssoLogin.verifyFailed')));
        return;
      }

      finish(200, renderCallbackPage(t('ssoLogin.loginDoneTitle'), t('ssoLogin.closeWindow')));
      clearTimeout(timeout);
      resolve({ code });
    });
  });
}

async function writeSsoTokenCache(input: {
  awsRootDir: string;
  cacheKeyId: string;
  startUrl: string;
  ssoRegion: string;
  accessToken: string;
  expiresAt: string;
  refreshToken?: string;
  clientId: string;
  clientSecret: string;
  clientSecretExpiresAt?: number;
}): Promise<void> {
  const cachePath = resolveSsoCacheFilePath(input.awsRootDir, input.cacheKeyId);
  await mkdir(path.dirname(cachePath), { recursive: true });
  const entry: Record<string, string> = {
    accessToken: input.accessToken,
    expiresAt: input.expiresAt,
    region: input.ssoRegion,
    startUrl: input.startUrl,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
  };
  if (input.refreshToken) {
    entry.refreshToken = input.refreshToken;
  }
  if (input.clientSecretExpiresAt) {
    entry.registrationExpiresAt = new Date(
      input.clientSecretExpiresAt * 1000,
    ).toISOString();
  }
  await writeFile(cachePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export async function performAwsSsoLogin(
  input: AwsSsoLoginInput,
): Promise<AwsSsoLoginResult> {
  const startUrl = input.startUrl.trim();
  const ssoRegion = input.ssoRegion.trim();
  if (!startUrl || !ssoRegion) {
    throw new Error(t('ssoLogin.startUrlRequired'));
  }
  const oidc = input.oidc ?? new SdkAwsSsoOidcApi();
  const timeoutMs = input.timeoutMs ?? DEFAULT_SSO_LOGIN_TIMEOUT_MS;

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${port}${SSO_CALLBACK_PATH}`;

    const registration = await oidc.registerClient({
      ssoRegion,
      startUrl,
      redirectUri,
      scopes: AWS_SSO_LOGIN_SCOPES,
    });

    const state = randomBytes(24).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const authorizeUrl = buildSsoAuthorizeUrl({
      ssoRegion,
      clientId: registration.clientId,
      redirectUri,
      state,
      codeChallenge,
    });

    const callbackPromise = waitForSsoCallback(server, state, timeoutMs);
    // The callback can reject while the browser round-trip (openExternal) is
    // still awaited; mark it handled to avoid an unhandled-rejection window.
    callbackPromise.catch(() => {});
    await input.openExternal(authorizeUrl);
    const callback = await callbackPromise;

    const token = await oidc.createToken({
      ssoRegion,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      code: callback.code,
      redirectUri,
      codeVerifier,
    });

    const expiresAt = new Date(
      Date.now() + Math.max(token.expiresInSeconds, 60) * 1000,
    ).toISOString();
    await writeSsoTokenCache({
      awsRootDir: input.awsRootDir,
      cacheKeyId: input.sessionName?.trim() || startUrl,
      startUrl,
      ssoRegion,
      accessToken: token.accessToken,
      expiresAt,
      refreshToken: token.refreshToken,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      clientSecretExpiresAt: registration.clientSecretExpiresAt,
    });

    return { accessToken: token.accessToken, expiresAt };
  } finally {
    server.close();
  }
}
