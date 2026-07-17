import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsRepository } from './database';

const updaterMocks = vi.hoisted(() => {
  const listeners = new Map<string, (payload?: unknown) => void>();
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    setFeedURL: vi.fn(),
    on: vi.fn((event: string, listener: (payload?: unknown) => void) => {
      listeners.set(event, listener);
    }),
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
  };
  return { autoUpdater, listeners };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '1.0.0',
    getPath: () => '/tmp/dolgate-test',
  },
  BrowserWindow: class BrowserWindow {},
}));

vi.mock('electron-updater', () => ({
  autoUpdater: updaterMocks.autoUpdater,
}));

import { UpdateService } from './update-service';

describe('UpdateService automatic downloads', () => {
  beforeEach(() => {
    updaterMocks.listeners.clear();
    updaterMocks.autoUpdater.autoDownload = false;
    updaterMocks.autoUpdater.autoInstallOnAppQuit = true;
    updaterMocks.autoUpdater.allowPrerelease = true;
    updaterMocks.autoUpdater.allowDowngrade = true;
    vi.clearAllMocks();
  });

  it('downloads in the background but waits for explicit restart before installation', () => {
    const settings = {
      get: vi.fn(() => ({ dismissedUpdateVersion: null })),
      update: vi.fn(),
    } as unknown as SettingsRepository;

    const service = new UpdateService(settings);

    expect(updaterMocks.autoUpdater.autoDownload).toBe(true);
    expect(updaterMocks.autoUpdater.autoInstallOnAppQuit).toBe(false);
    expect(updaterMocks.autoUpdater.allowPrerelease).toBe(false);
    expect(updaterMocks.autoUpdater.allowDowngrade).toBe(false);

    updaterMocks.listeners.get('update-available')?.({
      version: '1.1.0',
      releaseName: 'Dolgate 1.1.0',
      releaseNotes: null,
      releaseDate: '2026-07-17T00:00:00.000Z',
    });
    expect(service.getState()).toMatchObject({
      status: 'available',
      release: { version: '1.1.0' },
    });

    updaterMocks.listeners.get('update-downloaded')?.({
      version: '1.1.0',
      releaseName: 'Dolgate 1.1.0',
      releaseNotes: null,
      releaseDate: '2026-07-17T00:00:00.000Z',
    });
    expect(service.getState()).toMatchObject({
      status: 'downloaded',
      release: { version: '1.1.0' },
    });
    expect(updaterMocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});
