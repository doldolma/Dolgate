import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSsoAuthorizeUrl,
  performAwsSsoLogin,
  resolveSsoCacheFilePath,
  type AwsSsoOidcApi,
} from './aws-sso-login';

const tempDirectories: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dolssh-sso-login-'));
  tempDirectories.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirectories.length > 0) {
    const dir = tempDirectories.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function createFakeOidc(): AwsSsoOidcApi & {
  createTokenCalls: Array<Record<string, string>>;
} {
  const createTokenCalls: Array<Record<string, string>> = [];
  return {
    createTokenCalls,
    async registerClient() {
      return {
        clientId: 'client-1',
        clientSecret: 'secret-1',
        clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
      };
    },
    async createToken(input) {
      createTokenCalls.push({ code: input.code, codeVerifier: input.codeVerifier });
      return {
        accessToken: 'access-token-1',
        refreshToken: 'refresh-token-1',
        expiresInSeconds: 3600,
      };
    },
  };
}

describe('buildSsoAuthorizeUrl', () => {
  it('builds the regional authorize URL with PKCE parameters', () => {
    const url = new URL(
      buildSsoAuthorizeUrl({
        ssoRegion: 'ap-northeast-2',
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:4242/oauth/callback',
        state: 'state-1',
        codeChallenge: 'challenge-1',
      }),
    );
    expect(url.origin).toBe('https://oidc.ap-northeast-2.amazonaws.com');
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('scopes')).toBe('sso:account:access');
  });
});

describe('resolveSsoCacheFilePath', () => {
  it('keys the cache file by sha1 like the AWS SDK/CLI', () => {
    const digest = createHash('sha1').update('corp-session').digest('hex');
    expect(resolveSsoCacheFilePath('/tmp/aws-root', 'corp-session')).toBe(
      path.join('/tmp/aws-root', 'sso', 'cache', `${digest}.json`),
    );
  });
});

describe('performAwsSsoLogin', () => {
  it('completes the loopback flow and writes a CLI-compatible token cache', async () => {
    const awsRootDir = await createTempDir();
    const oidc = createFakeOidc();

    const result = await performAwsSsoLogin({
      startUrl: 'https://example.awsapps.com/start',
      ssoRegion: 'ap-northeast-2',
      sessionName: 'corp-session',
      awsRootDir,
      oidc,
      timeoutMs: 5_000,
      openExternal: async (authorizeUrl) => {
        // Stand-in for the user's browser: bounce the code back to the
        // loopback redirect with the same state.
        const parsed = new URL(authorizeUrl);
        const redirectUri = new URL(parsed.searchParams.get('redirect_uri')!);
        redirectUri.searchParams.set('code', 'auth-code-1');
        redirectUri.searchParams.set('state', parsed.searchParams.get('state')!);
        const response = await fetch(redirectUri);
        expect(response.status).toBe(200);
      },
    });

    expect(result.accessToken).toBe('access-token-1');
    expect(oidc.createTokenCalls).toHaveLength(1);
    expect(oidc.createTokenCalls[0].code).toBe('auth-code-1');

    const cachePath = resolveSsoCacheFilePath(awsRootDir, 'corp-session');
    const entry = JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, string>;
    expect(entry).toMatchObject({
      accessToken: 'access-token-1',
      refreshToken: 'refresh-token-1',
      region: 'ap-northeast-2',
      startUrl: 'https://example.awsapps.com/start',
      clientId: 'client-1',
      clientSecret: 'secret-1',
    });
    expect(Date.parse(entry.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('rejects when the callback carries an OAuth error', async () => {
    const awsRootDir = await createTempDir();
    const oidc = createFakeOidc();

    await expect(
      performAwsSsoLogin({
        startUrl: 'https://example.awsapps.com/start',
        ssoRegion: 'ap-northeast-2',
        sessionName: 'corp-session',
        awsRootDir,
        oidc,
        timeoutMs: 5_000,
        openExternal: async (authorizeUrl) => {
          const parsed = new URL(authorizeUrl);
          const redirectUri = new URL(parsed.searchParams.get('redirect_uri')!);
          redirectUri.searchParams.set('error', 'access_denied');
          redirectUri.searchParams.set('error_description', '사용자가 요청을 거부했습니다.');
          await fetch(redirectUri);
        },
      }),
    ).rejects.toThrow('사용자가 요청을 거부했습니다.');
    expect(oidc.createTokenCalls).toHaveLength(0);
  });

  it('rejects when the state does not match', async () => {
    const awsRootDir = await createTempDir();
    const oidc = createFakeOidc();

    await expect(
      performAwsSsoLogin({
        startUrl: 'https://example.awsapps.com/start',
        ssoRegion: 'ap-northeast-2',
        sessionName: 'corp-session',
        awsRootDir,
        oidc,
        timeoutMs: 5_000,
        openExternal: async (authorizeUrl) => {
          const parsed = new URL(authorizeUrl);
          const redirectUri = new URL(parsed.searchParams.get('redirect_uri')!);
          redirectUri.searchParams.set('code', 'auth-code-1');
          redirectUri.searchParams.set('state', 'forged-state');
          await fetch(redirectUri);
        },
      }),
    ).rejects.toThrow('AWS SSO 인증 응답 검증에 실패했습니다.');
    expect(oidc.createTokenCalls).toHaveLength(0);
  });
});
