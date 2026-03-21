import { BrowserWindow, app } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { UpdateEvent, UpdateReleaseInfo, UpdateState } from '@dolssh/shared';
import { ipcChannels } from '../common/ipc-channels';
import { SettingsRepository } from './database';

const githubReleaseFeed = {
  provider: 'github',
  owner: 'doldolma',
  repo: 'dolssh',
  releaseType: 'release',
  vPrefixedTagName: true,
  private: false
} as const;

function normalizeReleaseNotes(notes: UpdateInfo['releaseNotes']): string | null {
  if (typeof notes === 'string') {
    return notes;
  }

  if (Array.isArray(notes)) {
    return notes
      .map((note) => (typeof note.note === 'string' ? note.note.trim() : ''))
      .filter(Boolean)
      .join('\n\n');
  }

  return null;
}

function toReleaseInfo(info: UpdateInfo): UpdateReleaseInfo {
  return {
    version: info.version,
    releaseName: info.releaseName ?? null,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    publishedAt: info.releaseDate ?? null
  };
}

function toProgressInfo(progress: ProgressInfo) {
  return {
    percent: progress.percent,
    bytesPerSecond: progress.bytesPerSecond,
    transferred: progress.transferred,
    total: progress.total
  };
}

export class UpdateService {
  private readonly windows = new Set<BrowserWindow>();
  private initialCheckScheduled = false;
  private pendingInstall = false;
  private periodicCheckTimer: NodeJS.Timeout | null = null;
  private activeCheckPromise: Promise<void> | null = null;
  private state: UpdateState = {
    enabled: app.isPackaged,
    status: 'idle',
    currentVersion: app.getVersion(),
    dismissedVersion: null,
    release: null,
    progress: null,
    checkedAt: null,
    errorMessage: null
  };

  constructor(private readonly settings: SettingsRepository) {
    this.state.dismissedVersion = this.settings.get().dismissedUpdateVersion ?? null;

    if (app.isPackaged) {
      // prepackaged -> electron-builder 경로에서는 app-update.yml이 번들되지 않을 수 있어서
      // GitHub Releases feed를 런타임에서 직접 주입해 파일 의존을 없앤다.
      autoUpdater.setFeedURL(githubReleaseFeed);
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;

    autoUpdater.on('checking-for-update', () => {
      this.patchState({
        status: 'checking',
        checkedAt: new Date().toISOString(),
        errorMessage: null,
        progress: null
      });
    });

    autoUpdater.on('update-available', (info) => {
      this.patchState({
        status: 'available',
        checkedAt: new Date().toISOString(),
        release: toReleaseInfo(info),
        progress: null,
        errorMessage: null
      });
    });

    autoUpdater.on('update-not-available', () => {
      this.patchState({
        status: 'upToDate',
        checkedAt: new Date().toISOString(),
        release: null,
        progress: null,
        errorMessage: null
      });
    });

    autoUpdater.on('download-progress', (progress) => {
      this.patchState({
        status: 'downloading',
        progress: toProgressInfo(progress),
        errorMessage: null
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.patchState({
        status: 'downloaded',
        release: toReleaseInfo(info),
        progress: null,
        errorMessage: null
      });
    });

    autoUpdater.on('error', (error) => {
      this.patchState({
        status: 'error',
        checkedAt: new Date().toISOString(),
        errorMessage: error == null ? '업데이트 확인 중 알 수 없는 오류가 발생했습니다.' : String(error.message || error),
        progress: null
      });
    });
  }

  registerWindow(window: BrowserWindow): void {
    this.windows.add(window);
    window.on('closed', () => {
      this.windows.delete(window);
    });
  }

  getState(): UpdateState {
    return this.state;
  }

  scheduleInitialCheck(delayMs = 15_000): void {
    if (!this.state.enabled || this.initialCheckScheduled) {
      return;
    }
    this.initialCheckScheduled = true;
    setTimeout(() => {
      void this.check();
    }, delayMs);

    // 앱을 오래 켜 두는 사용자를 위해 주기적으로 GitHub Releases를 다시 확인한다.
    // 이미 새 버전을 들고 있거나 다운로드 중인 경우에는 중복 체크를 생략한다.
    this.periodicCheckTimer = setInterval(() => {
      void this.check();
    }, 1000 * 60 * 60 * 4);
  }

  async check(): Promise<void> {
    if (!this.state.enabled) {
      this.patchState({
        status: 'idle',
        errorMessage: null
      });
      return;
    }

    if (this.activeCheckPromise) {
      return this.activeCheckPromise;
    }

    if (this.state.status === 'available' || this.state.status === 'downloading' || this.state.status === 'downloaded') {
      return;
    }

    this.activeCheckPromise = autoUpdater.checkForUpdates().then(() => undefined).finally(() => {
      this.activeCheckPromise = null;
    });

    return this.activeCheckPromise;
  }

  async download(): Promise<void> {
    if (!this.state.enabled) {
      return;
    }

    await autoUpdater.downloadUpdate();
  }

  async dismissAvailable(version: string): Promise<void> {
    this.settings.update({ dismissedUpdateVersion: version });
    this.patchState({
      dismissedVersion: version
    });
  }

  async installAndRestart(): Promise<void> {
    if (!this.state.enabled || this.state.status !== 'downloaded') {
      throw new Error('다운로드된 업데이트가 없습니다.');
    }

    this.pendingInstall = true;
    app.quit();
  }

  consumePendingInstall(): boolean {
    const pending = this.pendingInstall;
    this.pendingInstall = false;
    return pending;
  }

  quitAndInstall(): void {
    autoUpdater.quitAndInstall(false, true);
  }

  private patchState(patch: Partial<UpdateState>): void {
    this.state = {
      ...this.state,
      ...patch
    };
    this.broadcast({
      state: this.state
    });
  }

  private broadcast(event: UpdateEvent): void {
    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.updater.event, event);
      }
    }
  }
}
