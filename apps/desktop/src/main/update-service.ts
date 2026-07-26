import { BrowserWindow, Notification, app } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { UpdateEvent, UpdateReleaseInfo, UpdateState } from '@shared';
import { ipcChannels } from '../common/ipc-channels';
import { SettingsRepository } from './database';

// deb/rpm 설치본에서 설치 직후 app.relaunch()로 자동 재시작하면 Ubuntu 24.04+의
// AppArmor/샌드박스 초기화와 충돌해 SIGTRAP 크래시 다이얼로그가 뜬다(수동 재실행은 정상).
// AppImage(process.env.APPIMAGE 설정됨)는 electron-updater의 검증된 경로라 자동 재시작을 유지한다.
const requiresManualRelaunchAfterInstall =
  process.platform === 'linux' && !process.env.APPIMAGE;

const githubReleaseFeed = {
  provider: 'github',
  owner: 'doldolma',
  repo: 'dolgate',
  releaseType: 'release',
  vPrefixedTagName: true,
  private: false
} as const;

function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function stripHtml(input: string): string {
  return decodeHtmlEntities(
    input
      .replace(/<\s*br\s*\/?>/giu, '\n')
      .replace(/<\s*\/p\s*>/giu, '\n\n')
      .replace(/<\s*li\s*>/giu, '\n- ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeReleaseNotes(notes: UpdateInfo['releaseNotes']): string | null {
  if (typeof notes === 'string') {
    return stripHtml(notes);
  }

  if (Array.isArray(notes)) {
    return notes
      .map((note) => (typeof note.note === 'string' ? stripHtml(note.note) : ''))
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

function normalizeUpdaterError(error: unknown): string {
  const message = error == null ? '' : String((error as { message?: string }).message || error);
  const lowered = message.toLowerCase();

  if (
    lowered.includes('code signature at url') ||
    lowered.includes('did not pass validation') ||
    lowered.includes('code object is not signed at all') ||
    message.includes('코드 객체가 전혀 서명되지')
  ) {
    return '이 mac 릴리즈는 코드 서명되지 않은 앱이라 자동 업데이트를 적용할 수 없습니다. 나중에 서명된 버전이 배포되면 앱 안에서 바로 업데이트할 수 있습니다.';
  }

  return message || '업데이트 확인 중 알 수 없는 오류가 발생했습니다.';
}

function ensureRuntimeUpdateConfig(): void {
  if (!app.isPackaged) {
    return;
  }

  const updateConfigPath = path.join(app.getPath('userData'), 'runtime-app-update.yml');
  const updateConfigYaml = [
    'provider: github',
    'owner: doldolma',
    'repo: dolgate',
    'releaseType: release',
    'vPrefixedTagName: true',
    'updaterCacheDirName: dolgate-updater'
  ].join('\n');

  mkdirSync(path.dirname(updateConfigPath), { recursive: true });
  writeFileSync(updateConfigPath, `${updateConfigYaml}\n`, 'utf8');
  // electron-updater 타입에는 노출되지 않지만, 런타임 override setter가 존재한다.
  (autoUpdater as typeof autoUpdater & { updateConfigPath: string }).updateConfigPath = updateConfigPath;
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
      ensureRuntimeUpdateConfig();
      // prepackaged -> electron-builder 경로에서는 app-update.yml이 번들되지 않을 수 있어서
      // GitHub Releases feed를 런타임에서 직접 주입해 파일 의존을 없앤다.
      autoUpdater.setFeedURL(githubReleaseFeed);
    }

    // 새 릴리즈는 백그라운드에서 미리 받아 두고, 적용 시점만 사용자가 선택한다.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    if (requiresManualRelaunchAfterInstall) {
      autoUpdater.autoRunAppAfterInstall = false;
    }

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
        errorMessage: normalizeUpdaterError(error),
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
    }, 1000 * 60 * 60);
  }

  // macOS 는 창을 닫아도 프로세스가 살아 있어(window-all-closed 에서 quit 하지 않는다)
  // 부팅 때 1회 예약한 초기 확인이 다시 돌지 않는다. 그래서 창만 닫았다 다시 열면
  // 1시간 주기가 오기 전까지 새 릴리즈를 못 본다 — 창을 다시 열 때 마지막 확인이
  // 오래됐으면 한 번 더 확인한다. 중복 호출은 check() 의 가드가 막는다.
  checkIfStale(maxAgeMs = 30 * 60 * 1000): void {
    if (!this.state.enabled) {
      return;
    }
    const checkedAt = this.state.checkedAt ? Date.parse(this.state.checkedAt) : Number.NaN;
    if (Number.isFinite(checkedAt) && Date.now() - checkedAt < maxAgeMs) {
      return;
    }
    void this.check();
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
    if (requiresManualRelaunchAfterInstall && Notification.isSupported()) {
      // 자동 재시작을 껐으므로 설치 후 앱이 종료된 채로 남는다 — 사용자가 다시 열도록 안내.
      new Notification({
        title: 'Dolgate 업데이트',
        body: '업데이트를 설치합니다. 설치가 끝나면 Dolgate를 다시 열어 주세요.'
      }).show();
    }
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
