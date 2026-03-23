import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let mockedAppPath = '/tmp/dolssh-app';
let mockedUserDataPath = '/tmp/dolssh-user-data';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => mockedAppPath),
    getPath: vi.fn((name: string) => (name === 'userData' ? mockedUserDataPath : os.tmpdir()))
  }
}));

import { DesktopConfigService } from './app-config';

describe('DesktopConfigService', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dolssh-config-'));
    mockedAppPath = tempDir;
    mockedUserDataPath = path.join(tempDir, 'user-data');
    await fs.mkdir(mockedUserDataPath, { recursive: true });
    delete process.env.DOLSSH_DESKTOP_CONFIG_PATH;
  });

  afterEach(async () => {
    delete process.env.DOLSSH_DESKTOP_CONFIG_PATH;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('falls back to the example config file when the requested file is absent', async () => {
    const requestedPath = path.join(tempDir, 'desktop.json');
    const examplePath = path.join(tempDir, 'desktop.example.json');
    await fs.writeFile(
      examplePath,
      JSON.stringify({
        sync: {
          serverUrl: 'https://example-sync.test',
          desktopClientId: 'desktop-example'
        }
      })
    );
    process.env.DOLSSH_DESKTOP_CONFIG_PATH = requestedPath;

    const service = new DesktopConfigService();
    expect(service.getConfig()).toEqual({
      sync: {
        serverUrl: 'https://example-sync.test',
        desktopClientId: 'desktop-example',
        redirectUri: 'dolssh://auth/callback'
      }
    });
  });

  it('merges the bundled config with the user override file', async () => {
    const requestedPath = path.join(tempDir, 'desktop.json');
    await fs.writeFile(
      requestedPath,
      JSON.stringify({
        sync: {
          serverUrl: 'https://bundled.example.com',
          desktopClientId: 'bundled-client'
        }
      })
    );
    await fs.writeFile(
      path.join(mockedUserDataPath, 'desktop-config.json'),
      JSON.stringify({
        sync: {
          redirectUri: 'dolssh://override/callback'
        }
      })
    );
    process.env.DOLSSH_DESKTOP_CONFIG_PATH = requestedPath;

    const service = new DesktopConfigService();
    expect(service.getConfig()).toEqual({
      sync: {
        serverUrl: 'https://bundled.example.com',
        desktopClientId: 'bundled-client',
        redirectUri: 'dolssh://override/callback'
      }
    });
    expect(service.getUserOverridePath()).toBe(path.join(mockedUserDataPath, 'desktop-config.json'));
  });

  it('falls back to built-in defaults when configured values are blank', async () => {
    const requestedPath = path.join(tempDir, 'desktop.json');
    await fs.writeFile(
      requestedPath,
      JSON.stringify({
        sync: {
          serverUrl: '   ',
          desktopClientId: '',
          redirectUri: '  '
        }
      })
    );
    process.env.DOLSSH_DESKTOP_CONFIG_PATH = requestedPath;

    const service = new DesktopConfigService();
    expect(service.getConfig()).toEqual({
      sync: {
        serverUrl: 'https://ssh.doldolma.com',
        desktopClientId: 'dolssh-desktop',
        redirectUri: 'dolssh://auth/callback'
      }
    });
  });
});
