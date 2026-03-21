import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface DesktopAppConfig {
  sync: {
    serverUrl: string;
    desktopClientId: string;
    redirectUri: string;
  };
}

const DEFAULT_CONFIG: DesktopAppConfig = {
  sync: {
    serverUrl: 'https://ssh.doldolma.com',
    desktopClientId: 'dolssh-desktop',
    redirectUri: 'dolssh://auth/callback'
  }
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(next[key])) {
      next[key] = mergeConfig(next[key] as Record<string, unknown>, value);
      continue;
    }
    next[key] = value;
  }
  return next;
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function toExamplePath(filePath: string): string {
  if (filePath.endsWith('.example.json')) {
    return filePath;
  }
  if (filePath.endsWith('.json')) {
    return filePath.replace(/\.json$/u, '.example.json');
  }
  return `${filePath}.example`;
}

function readFirstExistingJsonFile<T>(filePaths: string[]): T | null {
  for (const filePath of filePaths) {
    const parsed = readJsonFile<T>(filePath);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function normalizeConfig(input: Record<string, unknown>): DesktopAppConfig {
  const merged = mergeConfig(DEFAULT_CONFIG as unknown as Record<string, unknown>, input);
  const sync = isObject(merged.sync) ? merged.sync : {};

  return {
    sync: {
      serverUrl: typeof sync.serverUrl === 'string' && sync.serverUrl.trim() ? sync.serverUrl.trim() : DEFAULT_CONFIG.sync.serverUrl,
      desktopClientId:
        typeof sync.desktopClientId === 'string' && sync.desktopClientId.trim()
          ? sync.desktopClientId.trim()
          : DEFAULT_CONFIG.sync.desktopClientId,
      redirectUri: typeof sync.redirectUri === 'string' && sync.redirectUri.trim() ? sync.redirectUri.trim() : DEFAULT_CONFIG.sync.redirectUri
    }
  };
}

export class DesktopConfigService {
  private cachedConfig: DesktopAppConfig | null = null;

  getConfig(): DesktopAppConfig {
    if (this.cachedConfig) {
      return this.cachedConfig;
    }

    const requestedConfigPath = process.env.DOLSSH_DESKTOP_CONFIG_PATH?.trim()
      ? path.resolve(process.env.DOLSSH_DESKTOP_CONFIG_PATH)
      : app.isPackaged
        ? path.join(process.resourcesPath, 'config', 'desktop.json')
        : path.join(app.getAppPath(), 'config', 'development.json');

    const userOverridePath = path.join(app.getPath('userData'), 'desktop-config.json');
    const bundled =
      readFirstExistingJsonFile<Record<string, unknown>>([requestedConfigPath, toExamplePath(requestedConfigPath)]) ?? {};
    const userOverride = requestedConfigPath === userOverridePath ? {} : readJsonFile<Record<string, unknown>>(userOverridePath) ?? {};
    this.cachedConfig = normalizeConfig(mergeConfig(bundled, userOverride));
    return this.cachedConfig;
  }

  getUserOverridePath(): string {
    return path.join(app.getPath('userData'), 'desktop-config.json');
  }
}
