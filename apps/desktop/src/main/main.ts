import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActivityLogRepository,
  GroupRepository,
  HostRepository,
  KnownHostRepository,
  PortForwardRepository,
  SecretMetadataRepository,
  SettingsRepository,
  SyncOutboxRepository
} from './database';
import { DesktopConfigService } from './app-config';
import { AuthService } from './auth-service';
import { CoreManager } from './core-manager';
import { registerIpcHandlers } from './ipc';
import { SecretStore } from './secret-store';
import { SyncService } from './sync-service';
import { UpdateService } from './update-service';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// main 프로세스에서 공유하는 런타임 인스턴스들이다.
const hostRepository = new HostRepository();
const groupRepository = new GroupRepository();
const settingsRepository = new SettingsRepository();
const portForwardRepository = new PortForwardRepository();
const knownHostRepository = new KnownHostRepository();
const activityLogRepository = new ActivityLogRepository();
const secretMetadataRepository = new SecretMetadataRepository();
const syncOutboxRepository = new SyncOutboxRepository();
const secretStore = new SecretStore();
const desktopConfigService = new DesktopConfigService();
const appendActivityLog = (entry: { level: 'info' | 'warn' | 'error'; category: 'session' | 'audit'; message: string; metadata?: Record<string, unknown> | null }) => {
  activityLogRepository.append(entry.level, entry.category, entry.message, entry.metadata ?? null);
};
const authService = new AuthService(secretStore, desktopConfigService, appendActivityLog);
const coreManager = new CoreManager((entry) => {
  appendActivityLog(entry);
});
const syncService = new SyncService(
  authService,
  hostRepository,
  groupRepository,
  portForwardRepository,
  knownHostRepository,
  secretMetadataRepository,
  settingsRepository,
  secretStore,
  syncOutboxRepository
);
const updateService = new UpdateService(settingsRepository);
let isQuitting = false;
let pendingAuthCallbackUrl: string | null = null;

type PatchedWriteStream = NodeJS.WriteStream & {
  __dolsshWriteGuardInstalled?: boolean;
};

function isBrokenPipeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && ((error as NodeJS.ErrnoException).code === 'EIO' || (error as NodeJS.ErrnoException).code === 'EPIPE');
}

function installDevStdioWriteGuard(): void {
  if (app.isPackaged) {
    return;
  }

  for (const candidate of [process.stdout, process.stderr] as PatchedWriteStream[]) {
    if (candidate.__dolsshWriteGuardInstalled) {
      continue;
    }
    candidate.__dolsshWriteGuardInstalled = true;

    const originalWrite = candidate.write.bind(candidate);
    candidate.write = ((chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      try {
        return originalWrite(chunk as never, encoding as never, callback as never);
      } catch (error) {
        if (isBrokenPipeError(error)) {
          if (typeof encoding === 'function') {
            encoding(null);
          }
          if (typeof callback === 'function') {
            callback(null);
          }
          return false;
        }
        throw error;
      }
    }) as typeof candidate.write;

    candidate.on('error', (error) => {
      if (isBrokenPipeError(error)) {
        return;
      }
      setImmediate(() => {
        throw error;
      });
    });
  }
}

function findProtocolUrl(argv: string[]): string | null {
  return argv.find((value) => value.startsWith('dolssh://')) ?? null;
}

async function handleAuthCallbackUrl(rawUrl: string): Promise<void> {
  try {
    await authService.handleCallbackUrl(rawUrl);
  } catch (error) {
    await authService.forceUnauthenticated(error instanceof Error ? error.message : '브라우저 로그인 교환에 실패했습니다.');
  }
}

async function createWindow(): Promise<void> {
  // renderer는 항상 preload를 거쳐서만 시스템 기능을 사용하게 강제한다.
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0d141a',
    webPreferences: {
      // forge + vite 출력에서는 main.js와 preload.js가 같은 build 디렉터리에 놓인다.
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  coreManager.registerWindow(window);
  authService.registerWindow(window);
  updateService.registerWindow(window);

  window.once('ready-to-show', () => {
    window.show();
    if (window.isMinimized()) {
      window.restore();
    }
    window.focus();
    app.focus();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    // 개발 모드에서는 Vite dev server를 로드한다.
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    // 패키징 이후에는 번들된 정적 파일을 로드한다.
    await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  if (!window.isVisible()) {
    window.show();
  }
  window.focus();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

installDevStdioWriteGuard();

app.on('second-instance', (_event, argv) => {
  const protocolUrl = findProtocolUrl(argv);
  if (protocolUrl) {
    pendingAuthCallbackUrl = protocolUrl;
    if (app.isReady()) {
      void handleAuthCallbackUrl(protocolUrl);
    }
  }

  const window = BrowserWindow.getAllWindows()[0];
  if (window) {
    if (window.isMinimized()) {
      window.restore();
    }
    window.focus();
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  pendingAuthCallbackUrl = url;
  if (app.isReady()) {
    void handleAuthCallbackUrl(url);
  }
});

authService.setOnSessionInvalidated(async () => {
  // 인증 세션이 사라지면 SSH/SFTP/포워딩 런타임도 함께 정리해서 로그인 게이트 뒤에 연결이 남지 않게 한다.
  await coreManager.shutdown();
  await syncService.purgeSyncedCache();
});

app.whenReady().then(async () => {
  // 앱 준비 이후에만 IPC와 창 생성을 시작한다.
  authService.registerProtocolClient();
  registerIpcHandlers(
    hostRepository,
    groupRepository,
    settingsRepository,
    portForwardRepository,
    knownHostRepository,
    activityLogRepository,
    secretMetadataRepository,
    syncOutboxRepository,
    secretStore,
    coreManager,
    updateService,
    authService,
    syncService
  );
  await createWindow();
  if (pendingAuthCallbackUrl) {
    const nextUrl = pendingAuthCallbackUrl;
    pendingAuthCallbackUrl = null;
    await handleAuthCallbackUrl(nextUrl);
  }
  updateService.scheduleInitialCheck();

  app.on('activate', async () => {
    // macOS에서는 모든 창이 닫혀도 앱이 살아 있으므로 다시 창을 열 수 있게 한다.
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('before-quit', (event) => {
  // 창 닫기와 앱 종료를 구분하되, 실제 Quit 시에는 SSH 코어를 정리한다.
  if (isQuitting) {
    return;
  }
  event.preventDefault();
  isQuitting = true;
  void coreManager.shutdown().finally(() => {
    if (updateService.consumePendingInstall()) {
      updateService.quitAndInstall();
      return;
    }
    app.quit();
  });
});

app.on('window-all-closed', () => {
  // macOS 관례를 따라 darwin 외 플랫폼에서만 앱을 완전히 종료한다.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
