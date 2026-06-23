import {
  app,
  BrowserWindow,
  Menu,
  powerMonitor,
  type MenuItemConstructorOptions,
} from 'electron';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isStaticDnsOverrideRecord } from '@shared';
import type { DesktopWindowState } from '@shared';
import {
  ActivityLogRepository,
  AwsProfileRepository,
  DnsOverrideRepository,
  GroupRepository,
  HostRepository,
  KnownHostRepository,
  PortForwardRepository,
  SecretMetadataRepository,
  SettingsRepository,
  SnippetRepository,
  SyncOutboxRepository
} from './database';
import { DesktopConfigService } from './app-config';
import { AuthService } from './auth-service';
import { AwsService } from './aws-service';
import { AwsSsmTunnelService } from './aws-ssm-tunnel-service';
import { ipcChannels } from '../common/ipc-channels';
import { CoreManager } from './core-manager';
import { registerIpcHandlers } from './ipc';
import { collectActiveDnsOverrideEntries, HostsOverrideManager } from './hosts-override-manager';
import { OpenSshImportService } from './openssh-import-service';
import { SecretStore } from './secret-store';
import { SessionShareService } from './session-share-service';
import { SessionReplayService } from './session-replay-service';
import { SyncService } from './sync-service';
import { TermiusImportService } from './termius-import-service';
import { UpdateService } from './update-service';
import { NotificationService } from './notification-service';
import { registerNotificationsIpcHandlers } from './ipc/notifications';
import { WarpgateService } from './warpgate-service';
import { XshellImportService } from './xshell-import-service';
import { shouldRequestSingleInstanceLock } from './app-runtime-policy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const TERMIUS_HELPER_FLAG = '--dolssh-termius-helper';

// Cmd+W 를 "창 닫기"가 아니라 "현재 탭 닫기"(크롬식)로 바꾸기 위해 커스텀 메뉴를 쓴다.
// 기본 메뉴엔 Window>Close(Cmd+W, 창 닫기)가 있어 이를 대체해야 한다. 표준 역할
// (앱/편집/보기 — 복사·붙여넣기·종료 등)은 그대로 유지한다. Cmd+Shift+W 가 창 닫기.
function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin';
  const sendTabCommand = (payload: import('@shared').TabCommandPayload) => {
    BrowserWindow.getFocusedWindow()?.webContents.send(
      ipcChannels.window.tabCommand,
      payload,
    );
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ role: 'appMenu' as const }]
      : [{ label: '파일', submenu: [{ role: 'quit' as const }] }]),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: '탭',
      submenu: [
        {
          label: '다음 탭',
          accelerator: isMac ? 'Cmd+Alt+Right' : 'Ctrl+Tab',
          click: () => sendTabCommand({ kind: 'next' }),
        },
        {
          label: '이전 탭',
          accelerator: isMac ? 'Cmd+Alt+Left' : 'Ctrl+Shift+Tab',
          click: () => sendTabCommand({ kind: 'prev' }),
        },
        { type: 'separator' as const },
        ...Array.from({ length: 8 }, (_unused, i) => ({
          label: `${i + 1}번째 탭`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: () => sendTabCommand({ kind: 'index' as const, index: i + 1 }),
        })),
        {
          label: '마지막 탭',
          accelerator: 'CmdOrCtrl+9',
          click: () => sendTabCommand({ kind: 'last' }),
        },
        { type: 'separator' as const },
        {
          label: '닫은 탭 다시 열기',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => sendTabCommand({ kind: 'reopen' }),
        },
      ],
    },
    {
      label: '윈도우',
      submenu: [
        { role: 'minimize' },
        ...(isMac ? [{ role: 'zoom' as const }] : []),
        { type: 'separator' as const },
        {
          label: '탭 닫기',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send(
              ipcChannels.window.closeActiveTab,
            );
          },
        },
        { label: '창 닫기', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function resolveTermiusHelperAssetPath(filename: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'assets', 'termius', filename);
  }

  return path.resolve(__dirname, '../../assets/termius', filename);
}

async function runTermiusHelperProcess(argv: string[]): Promise<void> {
  const helperScript = resolveTermiusHelperAssetPath('termius-helper.cjs');
  const helperModule = require(helperScript) as {
    runTermiusHelper?: (helperArgv?: string[]) => Promise<void>;
  };

  if (typeof helperModule.runTermiusHelper !== 'function') {
    throw new Error(`Termius helper entrypoint was not found: ${helperScript}`);
  }

  await helperModule.runTermiusHelper(argv);
}

// main 프로세스에서 공유하는 런타임 인스턴스들이다.
const termiusHelperArgIndex = process.argv.indexOf(TERMIUS_HELPER_FLAG);

if (termiusHelperArgIndex >= 0) {
  void runTermiusHelperProcess(process.argv.slice(termiusHelperArgIndex + 1)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    app.exit(1);
  });
} else {
  const hostRepository = new HostRepository();
  const groupRepository = new GroupRepository();
  const desktopConfigService = new DesktopConfigService();
  const settingsRepository = new SettingsRepository(desktopConfigService);
  const portForwardRepository = new PortForwardRepository();
  const dnsOverrideRepository = new DnsOverrideRepository();
  const snippetRepository = new SnippetRepository();
  const knownHostRepository = new KnownHostRepository();
  const activityLogRepository = new ActivityLogRepository();
  const secretMetadataRepository = new SecretMetadataRepository();
  const awsProfileRepository = new AwsProfileRepository();
  const syncOutboxRepository = new SyncOutboxRepository();
  const secretStore = new SecretStore();
  const awsService = new AwsService(awsProfileRepository);
  const awsSsmTunnelService = new AwsSsmTunnelService({
    buildCommandEnv: () => awsService.buildManagedCommandEnv()
  });
  const warpgateService = new WarpgateService(secretStore);
  const termiusImportService = new TermiusImportService();
  const opensshImportService = new OpenSshImportService();
  const xshellImportService = new XshellImportService(() => app.getPath('documents'));
  const appendActivityLog = (entry: { level: 'info' | 'warn' | 'error'; category: 'session' | 'audit'; message: string; metadata?: Record<string, unknown> | null }) => {
    activityLogRepository.append(entry.level, entry.category, entry.message, entry.metadata ?? null);
  };
  const upsertActivityLog = (record: import('@shared').ActivityLogRecord) => {
    activityLogRepository.upsert(record);
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.logs.changed);
      }
    }
  };
  const authService = new AuthService(secretStore, desktopConfigService, settingsRepository, appendActivityLog);
  const coreManager = new CoreManager(
    (entry) => {
      appendActivityLog(entry);
    },
    upsertActivityLog,
  );
  const hostsOverrideManager = new HostsOverrideManager();
  const syncService = new SyncService(
    authService,
    hostRepository,
    groupRepository,
    portForwardRepository,
    dnsOverrideRepository,
    snippetRepository,
    knownHostRepository,
    secretMetadataRepository,
    awsProfileRepository,
    settingsRepository,
    secretStore,
    syncOutboxRepository
  );
  const sessionShareService = new SessionShareService(authService, coreManager);
  const sessionReplayService = new SessionReplayService(settingsRepository, coreManager);
  const updateService = new UpdateService(settingsRepository);
  const notificationService = new NotificationService();
  let isQuitting = false;
  let pendingAuthCallbackUrl: string | null = null;

  const rewriteDnsOverridesForCurrentState = async () => {
    const overrides = dnsOverrideRepository.list();
    hostsOverrideManager.pruneStaticOverrideStates(
      overrides.filter(isStaticDnsOverrideRecord).map((record) => record.id),
    );
    await hostsOverrideManager.rewrite(
      collectActiveDnsOverrideEntries(
        overrides,
        portForwardRepository.list(),
        coreManager.listPortForwardRuntimes(),
        hostsOverrideManager.getActiveStaticOverrideIds(),
      )
    );
  };
  const restoreDnsOverridesForStartup = async () => {
    const hasStaleManagedBlock = await hostsOverrideManager.hasManagedHostsBlock();
    if (!hasStaleManagedBlock) {
      return;
    }
    hostsOverrideManager.clearStaticOverrideStates();
    await hostsOverrideManager.clear();
  };
  const reconcileAwsHostProfileReferences = async () => {
    const updatedHosts = hostRepository.backfillAwsProfileReferences(
      awsProfileRepository.listMetadata().map((profile) => ({
        id: profile.id,
        name: profile.name
      }))
    );
    if (updatedHosts.length === 0) {
      return;
    }
    if (authService.getState().status === 'authenticated') {
      void syncService.pushDirty().catch(() => undefined);
      return;
    }
    syncService.markLocalChangesPendingPush();
  };
  syncService.setOnAppliedSnapshot(() => {
    void awsService.materializeManagedProfiles().catch(() => undefined);
    void reconcileAwsHostProfileReferences().catch(() => undefined);
    void rewriteDnsOverridesForCurrentState().catch(() => undefined);
  });

  authService.setOnSessionActivated((owner) => {
    activityLogRepository.activate(owner);
    sessionReplayService.activate(owner);
  });

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
    return argv.find((value) => value.startsWith('dolgate://')) ?? null;
  }

  async function handleAuthCallbackUrl(rawUrl: string): Promise<void> {
    try {
      await authService.handleCallbackUrl(rawUrl);
    } catch (error) {
      await authService.forceUnauthenticated(error instanceof Error ? error.message : '브라우저 로그인 교환에 실패했습니다.');
    }
  }

  function buildWindowState(window: BrowserWindow): DesktopWindowState {
    return {
      isMaximized: window.isMaximized()
    };
  }

  function wireWindowStateEvents(window: BrowserWindow): void {
    const emitState = () => {
      if (window.isDestroyed()) {
        return;
      }
      window.webContents.send(ipcChannels.window.stateChanged, buildWindowState(window));
    };

    window.on('maximize', emitState);
    window.on('unmaximize', emitState);
  }

  async function createWindow(): Promise<void> {
    // renderer는 항상 preload를 거쳐서만 시스템 기능을 사용하게 강제한다.
    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1080,
      minHeight: 700,
      show: false,
      backgroundColor: '#0d141a',
      ...(process.platform === 'win32' ? { frame: false } : {}),
      ...(process.platform === 'darwin'
        ? {
            titleBarStyle: 'hiddenInset' as const,
            // 타이틀바(~48px)에 맞춰 신호등을 세로 중앙으로 내린다.
            trafficLightPosition: { x: 18, y: 16 },
          }
        : {}),
      webPreferences: {
        // forge + vite 출력에서는 main.js와 preload.js가 같은 build 디렉터리에 놓인다.
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    if (process.platform === 'win32') {
      window.removeMenu();
    }

    wireWindowStateEvents(window);

    coreManager.registerWindow(window);
    authService.registerWindow(window);
    warpgateService.registerWindow(window);
    sessionShareService.registerWindow(window);
    updateService.registerWindow(window);
    notificationService.registerWindow(window);

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

  const hasSingleInstanceLock = shouldRequestSingleInstanceLock({
    isPackaged: app.isPackaged,
    allowMultiInstanceEnv: process.env.DOLSSH_E2E_ALLOW_MULTI_INSTANCE,
  })
    ? app.requestSingleInstanceLock()
    : true;
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

  authService.setOnSessionInvalidated(async (context) => {
    // 인증 세션이 사라지면 SSH/SFTP/포워딩 런타임도 함께 정리해서 로그인 게이트 뒤에 연결이 남지 않게 한다.
    sessionReplayService.shutdown();
    await sessionShareService.shutdown();
    await awsSsmTunnelService.shutdown();
    await coreManager.shutdown({ finalizePortForwardsAsStopped: true });
    hostsOverrideManager.clearStaticOverrideStates();
    await rewriteDnsOverridesForCurrentState().catch(() => undefined);
    sessionReplayService.deactivate();
    activityLogRepository.deactivate();
    if (context.purgeSyncedCache) {
      await syncService.purgeSyncedCache();
      return;
    }
    syncService.pause(null);
  });

  app.whenReady().then(async () => {
    // 앱 준비 이후에만 IPC와 창 생성을 시작한다.
    if (process.platform === 'win32') {
      // Squirrel.Windows가 등록하는 AppUserModelID와 일치시켜야 토스트 알림이
      // 올바른 앱으로 표시된다 (com.squirrel.<name>.<exe>).
      app.setAppUserModelId('com.squirrel.dolgate.dolgate');
    }
    authService.registerProtocolClient();
    registerIpcHandlers(
      hostRepository,
      groupRepository,
      settingsRepository,
      portForwardRepository,
      dnsOverrideRepository,
      snippetRepository,
      knownHostRepository,
      activityLogRepository,
      secretMetadataRepository,
      syncOutboxRepository,
      secretStore,
      awsService,
      awsSsmTunnelService,
      warpgateService,
      coreManager,
      hostsOverrideManager,
      updateService,
      authService,
      syncService,
      termiusImportService,
      opensshImportService,
      xshellImportService,
      sessionShareService,
      sessionReplayService
    );
    registerNotificationsIpcHandlers(notificationService);
    await awsService.migrateManagedProfilesFromFilesIfNeeded();
    await reconcileAwsHostProfileReferences();
    installApplicationMenu();
    await createWindow();
    void restoreDnsOverridesForStartup()
      .then(() => rewriteDnsOverridesForCurrentState())
      .catch(() => undefined);
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

    // 절전/화면잠금에서 복귀하면 navigator.onLine이 true여도 SSH 소켓이 죽어
    // 있을 수 있다. 렌더러에 알려 자동 재연결이 모든 세션을 즉시 재검증하게 한다.
    const notifyResume = () => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(ipcChannels.system.resume);
        }
      }
    };
    powerMonitor.on('resume', notifyResume);
    powerMonitor.on('unlock-screen', notifyResume);
  });

  app.on('before-quit', (event) => {
    // 창 닫기와 앱 종료를 구분하되, 실제 Quit 시에는 SSH 코어를 정리한다.
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    isQuitting = true;
    sessionReplayService.shutdown();
    void sessionShareService.shutdown().finally(() => {
      void awsSsmTunnelService.shutdown().finally(() => {
        void coreManager
          .shutdown({ finalizePortForwardsAsStopped: true })
          .finally(() => {
            void hostsOverrideManager.shutdown().finally(() => {
              if (updateService.consumePendingInstall()) {
                updateService.quitAndInstall();
                return;
              }
              app.quit();
            });
          });
      });
    });
  });

  app.on('window-all-closed', () => {
    // macOS 관례를 따라 darwin 외 플랫폼에서만 앱을 완전히 종료한다.
    if (process.platform !== 'darwin') {
      app.quit();
      return;
    }
    // macOS: 창을 닫아도(Cmd+W) 앱은 살아 있다. 종료가 아니라면 모든 터미널 세션을
    // 정리해 다시 열 때 깨끗하게 시작한다(어중간한 복원으로 tmux 이름/세션 목록만
    // 비는 문제 방지). 실제 Quit(isQuitting)이면 before-quit 의 shutdown 이 처리한다.
    if (!isQuitting) {
      coreManager.disconnectAllSessions();
    }
  });
}
