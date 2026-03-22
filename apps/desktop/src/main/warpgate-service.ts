import type { WarpgateConnectionInfo, WarpgateTargetSummary } from '@shared';
import { SecretStore } from './secret-store';

const WARPGATE_API_PATH = '/@warpgate/api';

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

function normalizeBaseUrl(baseUrl: string): URL {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error('Warpgate 주소를 입력해 주세요.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = new URL(`https://${trimmed}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Warpgate 주소는 http 또는 https여야 합니다.');
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

function buildApiUrl(baseUrl: string, endpointPath: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  const prefix = normalized.pathname === '/' ? '' : normalized.pathname;
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

function parseExternalHost(value: string | undefined, fallbackHost: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallbackHost;
  }

  try {
    return new URL(trimmed).hostname || fallbackHost;
  } catch {
    const withoutBrackets = trimmed.replace(/^\[/, '').replace(/\]$/, '');
    const colonIndex = withoutBrackets.lastIndexOf(':');
    if (colonIndex > 0 && withoutBrackets.indexOf(':') === colonIndex) {
      return withoutBrackets.slice(0, colonIndex) || fallbackHost;
    }
    return withoutBrackets || fallbackHost;
  }
}

async function requestJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'X-Warpgate-Token': token,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    let message = `Warpgate 요청에 실패했습니다. (${response.status})`;
    try {
      const payload = (await response.json()) as { message?: string; error?: string };
      message = payload.message ?? payload.error ?? message;
    } catch {
      const body = await response.text().catch(() => '');
      if (body.trim()) {
        message = body.trim();
      }
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export class WarpgateService {
  constructor(private readonly secretStore: SecretStore) {}

  private async persistToken(baseUrl: string, token: string): Promise<void> {
    await this.secretStore.save(tokenAccount(baseUrl), token.trim());
  }

  async getConnectionInfo(baseUrl: string, token: string): Promise<WarpgateConnectionInfo> {
    if (!token.trim()) {
      throw new Error('Warpgate API 토큰을 입력해 주세요.');
    }

    const normalized = normalizeBaseUrl(baseUrl);
    const info = await requestJson<WarpgateInfoResponse>(buildApiUrl(baseUrl, '/info'), token.trim());
    await this.persistToken(baseUrl, token);

    return {
      baseUrl: normalized.toString().replace(/\/$/, ''),
      sshHost: parseExternalHost(info.external_host, normalized.hostname),
      sshPort: info.ports?.ssh ?? 2222,
      username: info.username?.trim() || null
    };
  }

  async testConnection(baseUrl: string, token: string): Promise<WarpgateConnectionInfo> {
    const connectionInfo = await this.getConnectionInfo(baseUrl, token);
    await requestJson<WarpgateTargetApiRecord[]>(buildApiUrl(baseUrl, '/targets'), token.trim());
    return connectionInfo;
  }

  async listSshTargets(baseUrl: string, token: string): Promise<WarpgateTargetSummary[]> {
    if (!token.trim()) {
      throw new Error('Warpgate API 토큰을 입력해 주세요.');
    }
    const targets = await requestJson<WarpgateTargetApiRecord[]>(buildApiUrl(baseUrl, '/targets'), token.trim());
    await this.persistToken(baseUrl, token);
    return targets
      .filter((target) => target.kind === 'Ssh' && typeof target.name === 'string')
      .map((target) => ({
        id: target.group?.id ? `${target.group.id}:${target.name!}` : target.name!,
        name: target.name!,
        kind: 'ssh' as const
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  resolveSshEndpoint(baseUrl: string): { host: string; port: number } {
    const normalized = normalizeBaseUrl(baseUrl);
    return {
      host: normalized.hostname,
      port: 2222
    };
  }
}
