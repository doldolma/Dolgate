import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const electronMocks = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getVersion: () => '1.0.0',
    getPath: () => '/tmp/dolgate-test',
  },
}));

vi.mock('electron', () => ({
  app: electronMocks.app,
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

// macOS 는 창을 닫아도 프로세스가 살아 있어 부팅 시 1회 예약한 초기 확인이 다시 돌지
// 않는다(Cmd+Q 로 완전히 종료해야 재실행됨). 창을 다시 열 때의 재확인 경로를 고정한다.
describe('UpdateService.checkIfStale', () => {
  const createService = () => {
    const settings = {
      get: vi.fn(() => ({ dismissedUpdateVersion: null })),
      update: vi.fn(),
    } as unknown as SettingsRepository;
    return new UpdateService(settings);
  };

  beforeEach(() => {
    updaterMocks.listeners.clear();
    vi.clearAllMocks();
    electronMocks.app.isPackaged = true;
  });

  afterEach(() => {
    electronMocks.app.isPackaged = false;
  });

  it('checks when no check has run yet', () => {
    const service = createService();

    service.checkIfStale();

    expect(updaterMocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('skips while the last check is still fresh', () => {
    const service = createService();
    updaterMocks.listeners.get('update-not-available')?.();
    vi.clearAllMocks();

    service.checkIfStale();

    expect(updaterMocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('checks again once the last check is older than the cooldown', () => {
    const service = createService();
    updaterMocks.listeners.get('update-not-available')?.();
    vi.clearAllMocks();

    service.checkIfStale(0);

    expect(updaterMocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('stays disabled when the app is not packaged', () => {
    electronMocks.app.isPackaged = false;
    const service = createService();

    service.checkIfStale();

    expect(updaterMocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });
});
