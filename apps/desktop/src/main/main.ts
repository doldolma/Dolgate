import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  powerMonitor,
  screen,
  type MenuItemConstructorOptions,
} from 'electron';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isStaticDnsOverrideRecord } from '@shared';
import type { DesktopWindowLaunchIntent, DesktopWindowState } from '@shared';
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
  TailnetRepository,
  SnippetRepository,
  SyncOutboxRepository
} from './database';
import { AI_STORED_KEY_SECRET_ACCOUNTS } from './ai-service';
import { DesktopConfigService } from './app-config';
import { AuthService } from './auth-service';
import { AwsService } from './aws-service';
import { AwsSsmTunnelService } from './aws-ssm-tunnel-service';
import { ipcChannels } from '../common/ipc-channels';
import { APP_LOCALE_QUERY_PARAM } from '../common/i18n/locale';
import { CoreManager } from './core-manager';
import { getMainLocale, initMainI18n, onMainLocaleChanged, t } from './i18n';
import { registerIpcHandlers } from './ipc';
import { RdpManager } from './rdp-manager';
import { VncManager } from './vnc-manager';
import { collectActiveDnsOverrideEntries, HostsOverrideManager } from './hosts-override-manager';
import { OpenSshImportService } from './openssh-import-service';
import { isSecureStorageUsable, SecretStore } from './secret-store';
import { SessionShareService } from './session-share-service';
import { SessionReplayService } from './session-replay-service';
import { SyncService } from './sync-service';
import { matchCloseActiveTab, matchTabCommand } from './tab-shortcuts';
import {
  forgetRdpKeyboardCapture,
  isRdpKeyboardCaptureActive,
} from './rdp-keyboard-capture';
import { TermiusImportService } from './termius-import-service';
import { UpdateService } from './update-service';
import { NotificationService } from './notification-service';
import { registerNotificationsIpcHandlers } from './ipc/notifications';
import { WarpgateService } from './warpgate-service';
import { XshellImportService } from './xshell-import-service';
import { shouldRequestSingleInstanceLock } from './app-runtime-policy';
import type { ActivityLogMessage } from './activity-log-message';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const TERMIUS_HELPER_FLAG = '--dolssh-termius-helper';

const userDataOverride = process.env.DOLSSH_USER_DATA_DIR?.trim();
if (userDataOverride) {
  app.setPath('userData', path.resolve(userDataOverride));
}

// dev 전용: vite 가 `?v=` 버전 쿼리 모듈을 immutable(1년) 캐시로 내려주는데, Electron 의
// 디스크 캐시가 이를 앱 재시작 후에도 재사용해 "코드는 고쳤는데 창은 옛 모듈" 상태가
// 될 수 있다(모듈 로드 크래시가 캐시되면 빈 화면으로 고착). dev 에서는 HTTP 캐시를
// 통째로 꺼서 이 클래스의 문제를 원천 차단한다. 패키징 앱에는 영향이 없다.
if (!app.isPackaged) {
  app.commandLine.appendSwitch('disable-http-cache');
}

// 탭을 가진 워크스페이스 창들. Cmd+W 가 "탭 닫기"인 건 여기서만이고, 리플레이처럼 탭이
// 없는 보조 창에서는 창 자체를 닫아야 한다(안 그러면 아무 일도 일어나지 않는다 — 보조 창의
// 렌더러는 closeActiveTab 을 처리하지 않는다).
const workspaceWindowIds = new Set<number>();

// Cmd+W 를 "창 닫기"가 아니라 "현재 탭 닫기"(크롬식)로 바꾸기 위해 커스텀 메뉴를 쓴다.
// 기본 메뉴엔 Window>Close(Cmd+W, 창 닫기)가 있어 이를 대체해야 한다. 표준 역할
// (앱/편집/보기 — 복사·붙여넣기·종료 등)은 그대로 유지한다. Cmd+Shift+W 가 창 닫기.
function installApplicationMenu(openNewWindow: () => void): void {
  const isMac = process.platform === 'darwin';
  const sendTabCommand = (payload: import('@shared').TabCommandPayload) => {
    BrowserWindow.getFocusedWindow()?.webContents.send(
      ipcChannels.window.tabCommand,
      payload,
    );
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: t('menu.file'),
      submenu: [
        {
          // id 는 RDP 화면이 키보드를 쥔 동안 비활성화하기 위한 것이다
          // (rdp-keyboard-capture.ts). macOS 는 Cmd 를 원격 Ctrl 로 옮기므로 Cmd+N 이 원격의
          // 새 문서/창이 되어야 한다.
          id: 'window-new',
          label: t('menu.newWindow'),
          accelerator: 'CmdOrCtrl+N',
          click: openNewWindow,
        },
        ...(!isMac
          ? [{ type: 'separator' as const }, { role: 'quit' as const }]
          : []),
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: t('menu.tabs'),
      submenu: [
        // 이 묶음의 id 는 전부 rdp-keyboard-capture.ts 가 비활성화 대상으로 쓴다.
        {
          id: 'tab-next',
          label: t('menu.nextTab'),
          accelerator: isMac ? 'Cmd+Alt+Right' : 'Ctrl+Tab',
          click: () => sendTabCommand({ kind: 'next' }),
        },
        {
          id: 'tab-prev',
          label: t('menu.prevTab'),
          accelerator: isMac ? 'Cmd+Alt+Left' : 'Ctrl+Shift+Tab',
          click: () => sendTabCommand({ kind: 'prev' }),
        },
        { type: 'separator' as const },
        ...Array.from({ length: 8 }, (_unused, i) => ({
          id: `tab-index-${i}`,
          label: t('menu.nthTab', { index: i + 1 }),
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: () => sendTabCommand({ kind: 'index' as const, index: i + 1 }),
        })),
        {
          id: 'tab-last',
          label: t('menu.lastTab'),
          accelerator: 'CmdOrCtrl+9',
          click: () => sendTabCommand({ kind: 'last' }),
        },
        { type: 'separator' as const },
        {
          id: 'tab-reopen',
          label: t('menu.reopenClosedTab'),
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => sendTabCommand({ kind: 'reopen' }),
        },
      ],
    },
    {
      label: t('menu.window'),
      submenu: [
        { role: 'minimize' },
        ...(isMac ? [{ role: 'zoom' as const }] : []),
        { type: 'separator' as const },
        {
          id: 'tab-close',
          label: t('menu.closeTab'),
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const focused = BrowserWindow.getFocusedWindow();
            if (!focused) {
              return;
            }
            if (!workspaceWindowIds.has(focused.id)) {
              focused.close();
              return;
            }
            focused.webContents.send(ipcChannels.window.closeActiveTab);
          },
        },
        { label: t('menu.closeWindow'), accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
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
  const tailnetRepository = new TailnetRepository();
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
  const awsSsmTunnelService = new AwsSsmTunnelService();
  const warpgateService = new WarpgateService(secretStore);
  const termiusImportService = new TermiusImportService();
  const opensshImportService = new OpenSshImportService();
  const xshellImportService = new XshellImportService(() => app.getPath('documents'));
  const appendActivityLog = (entry: {
    level: 'info' | 'warn' | 'error';
    category: 'session' | 'audit';
    message: string;
    messageKey?: string;
    messageParams?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
  }) => {
    // 키가 실려 온 로그는 키까지 저장해 화면이 현재 언어로 다시 그릴 수 있게 한다.
    const message: string | ActivityLogMessage = entry.messageKey
      ? {
          message: entry.message,
          messageKey: entry.messageKey,
          messageParams: entry.messageParams ?? null
        }
      : entry.message;
    activityLogRepository.append(entry.level, entry.category, message, entry.metadata ?? null);
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
  // RDP 는 별도 사이드카(services/rdp-core)를 쓰므로 CoreManager 와 독립적이다.
  const rdpManager = new RdpManager({
    getWindows: () => BrowserWindow.getAllWindows(),
    // SSH 세션과 같은 로그 저장소를 쓴다 — RDP 연결도 로그 화면·최근 접속에 함께 보인다.
    upsertLogRecord: upsertActivityLog,
  });

  // VNC 도 별도 사이드카(services/vnc-core)다. RDP 와 같은 이유로 CoreManager 와 독립적이다.
  const vncManager = new VncManager({
    getWindows: () => BrowserWindow.getAllWindows(),
    // RDP·SSH 와 같은 로그 저장소를 쓴다 — VNC 연결도 로그 화면과 **최근 접속 시각**에 함께 보인다.
    upsertLogRecord: upsertActivityLog,
  });

  awsSsmTunnelService.setInProcessBackend({
    shouldUse: () => awsService.shouldUseInProcessSsm(),
    start: (input) =>
      coreManager.startSsmTunnel({
        ruleId: input.runtimeId,
        profileName: input.profileName,
        region: input.region,
        targetType: "instance",
        targetId: input.instanceId,
        bindAddress: input.bindAddress,
        bindPort: input.bindPort,
        targetKind: "instance-port",
        targetPort: input.targetPort,
      }),
    stop: (runtimeId) => coreManager.stopSsmTunnel(runtimeId),
  });
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
    syncOutboxRepository,
    tailnetRepository
  );
  const sessionShareService = new SessionShareService(authService, coreManager);
  const sessionReplayService = new SessionReplayService(settingsRepository, coreManager);
  // 녹화가 보존 한도로 prune되거나(또는 로그인 시 재조정) 하면, 더 이상 파일이 없는 세션 로그의
  // hasReplay를 꺼서 "Replay 버튼은 뜨는데 눌러도 무반응"이던 문제를 막는다. 변경분은 렌더러에
  // 통지해 버튼이 즉시 사라지게 한다.
  const reconcileReplayLogFlags = () => {
    const changed = activityLogRepository.reconcileReplayFlags(
      sessionReplayService.listExistingRecordingIds(),
    );
    if (changed === 0) {
      return;
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.logs.changed);
      }
    }
  };
  sessionReplayService.setOnRecordingsPruned(reconcileReplayLogFlags);
  const updateService = new UpdateService(settingsRepository);
  const notificationService = new NotificationService();
  let isQuitting = false;
  let pendingAuthCallbackUrl: string | null = null;
  const launchIntentsByWindowId = new Map<number, DesktopWindowLaunchIntent>();

  const broadcastWorkspaceChanged = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.bootstrap.workspaceChanged);
      }
    }
  };

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
    const updatedHosts = hostRepository.refreshAwsProfileNameCaches(
      awsProfileRepository.listMetadata().map((profile) => ({
        id: profile.id,
        name: profile.name
      }))
    );
    if (updatedHosts.length === 0) {
      return;
    }
    broadcastWorkspaceChanged();
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
    // 다른 기기에서 등록한 tailnet 이 동기화로 내려왔을 수 있다. 코어에 알려 주지 않으면
    // 그 tailnet 을 쓰는 호스트가 "is not configured" 로 실패한다.
    coreManager.pushTailnetConfigs();
    broadcastWorkspaceChanged();
  });
  syncService.setOnPurgedSyncedCache(() =>
    awsService.purgeManagedProfileArtifacts()
  );

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
      await authService.forceUnauthenticated(error instanceof Error ? error.message : t('auth.browserExchangeFailed'));
    }
  }

  function buildWindowState(window: BrowserWindow): DesktopWindowState {
    return {
      isMaximized: window.isMaximized(),
      isFullScreen: window.isFullScreen()
    };
  }

  function wireWindowStateEvents(window: BrowserWindow): void {
    // 마지막으로 보낸 상태. resize 는 드래그 한 번에 수십 번 오므로, 값이 실제로 바뀔 때만 보낸다.
    let last: DesktopWindowState | null = null;
    const emitState = () => {
      if (window.isDestroyed()) {
        return;
      }
      const state = buildWindowState(window);
      if (
        last &&
        last.isMaximized === state.isMaximized &&
        last.isFullScreen === state.isFullScreen
      ) {
        return;
      }
      last = state;
      window.webContents.send(ipcChannels.window.stateChanged, state);
    };

    // 어느 이벤트 하나에 기대지 않는다.
    //
    // 렌더러가 들고 있는 창 상태는 거울일 뿐이라, 전이 이벤트를 한 번 놓치면 그 뒤로 계속 어긋난
    // 채 남는다 — 전체화면인데 탭이 보이고, 창으로 돌아오면 탭이 사라지는 뒤집힘이 그것이다.
    // Windows 의 frame:false 창에서는 전체화면 전이가 enter/leave 없이 크기 변화로만 오는 경우가
    // 있어서(실측) 그 상황이 실제로 일어난다.
    //
    // 그래서 창의 기하·표시가 바뀔 수 있는 이벤트를 모두 듣는다. 위의 중복 제거가 있어 값이 실제로
    // 바뀔 때만 한 번 나가므로, resize 처럼 자주 오는 것을 넣어도 비용이 없다.
    window.on('maximize', emitState);
    window.on('unmaximize', emitState);
    window.on('enter-full-screen', emitState);
    window.on('leave-full-screen', emitState);
    window.on('resize', emitState);
    window.on('restore', emitState);
    window.on('show', emitState);
    window.on('focus', emitState);
  }

  async function createWindow(
    launchIntent?: DesktopWindowLaunchIntent,
  ): Promise<BrowserWindow> {
    const sourceWindow = BrowserWindow.getFocusedWindow();
    const sourceBounds = sourceWindow?.getNormalBounds();
    const defaultBounds = { width: 1440, height: 900 };
    const nextBounds = sourceBounds
      ? (() => {
          const display = screen.getDisplayMatching(sourceBounds);
          const width = Math.min(sourceBounds.width, display.workArea.width);
          const height = Math.min(sourceBounds.height, display.workArea.height);
          const x = Math.min(
            Math.max(display.workArea.x, sourceBounds.x + 24),
            display.workArea.x + display.workArea.width - width,
          );
          const y = Math.min(
            Math.max(display.workArea.y, sourceBounds.y + 24),
            display.workArea.y + display.workArea.height - height,
          );
          return { width, height, x, y };
        })()
      : defaultBounds;
    // renderer는 항상 preload를 거쳐서만 시스템 기능을 사용하게 강제한다.
    const window = new BrowserWindow({
      ...nextBounds,
      minWidth: 1080,
      minHeight: 700,
      show: false,
      // macOS 는 비활성 창의 첫 클릭을 창 활성화에만 쓰고 내용에는 주지 않는다. RDP 세션에서는
      // 그것이 "한 번은 포커스, 한 번은 실제 클릭" 이라는 두 번 클릭으로 나타난다. 창 단위
      // 옵션이라 캔버스만 골라 켤 수 없어서 창 전체에 켠다 — 비활성 상태의 첫 클릭이 버튼에도
      // 그대로 먹는다는 뜻이다(그래서 기본값이 false 다). Windows·Linux 에서는 무시된다.
      acceptFirstMouse: true,
      backgroundColor: '#0d141a',
      ...(process.platform === 'win32' || process.platform === 'linux' ? { frame: false } : {}),
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

    workspaceWindowIds.add(window.id);
    if (launchIntent) {
      launchIntentsByWindowId.set(window.id, launchIntent);
    }
    window.on('closed', () => {
      workspaceWindowIds.delete(window.id);
      launchIntentsByWindowId.delete(window.id);
      // 캡처를 쥔 채 닫히면 blur 가 오지 않는다. 지우지 않으면 앱 단축키가 영구히 죽는다.
      forgetRdpKeyboardCapture(window.id);
    });

    if (process.platform !== 'darwin') {
      window.setMenuBarVisibility(false);
    }

    // Win/Linux 탭 단축키는 메뉴 accelerator 만으론 안 된다: accelerator 가 렌더러가
    // 소비하지 않은 키에만 발동하는데 xterm 이 Ctrl+Tab 등을 먼저 삼킨다(홈 탭에서만
    // 동작하던 원인). 렌더러 도달 전 단계에서 가로채 탭 명령(이동·재열기·닫기)으로
    // 보낸다. preventDefault 로 이벤트가 소비되므로 남겨둔 메뉴 accelerator 와 이중
    // 발동은 없다.
    if (process.platform !== 'darwin') {
      window.webContents.on('before-input-event', (event, input) => {
        // 원격 화면이 키보드를 쥐고 있으면 아무것도 가로채지 않는다 — 이 단계에서 가져가면 캔버스는
        // 그 키를 아예 못 본다. 메뉴 accelerator 는 캔버스의 preventDefault 가 알아서 막으므로
        // (Win/Linux 는 렌더러가 소비하지 않은 키에만 발동) 여기만 비켜 주면 된다.
        if (isRdpKeyboardCaptureActive(window.id)) {
          return;
        }
        const command = matchTabCommand(input);
        if (command) {
          event.preventDefault();
          window.webContents.send(ipcChannels.window.tabCommand, command);
          return;
        }
        if (matchCloseActiveTab(input)) {
          event.preventDefault();
          window.webContents.send(ipcChannels.window.closeActiveTab);
        }
      });
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

    // 첫 프레임부터 올바른 언어로 그리도록 메인이 정한 로케일을 URL 로 넘긴다.
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      // 개발 모드에서는 Vite dev server를 로드한다.
      const devUrl = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      devUrl.searchParams.set(APP_LOCALE_QUERY_PARAM, getMainLocale());
      await window.loadURL(devUrl.toString());
    } else {
      // 패키징 이후에는 번들된 정적 파일을 로드한다.
      await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
        query: { [APP_LOCALE_QUERY_PARAM]: getMainLocale() },
      });
    }

    if (!window.isVisible()) {
      window.show();
    }
    window.focus();
    return window;
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
    const focusExistingWindow = () => {
      const window =
        BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (window) {
        if (window.isMinimized()) {
          window.restore();
        }
        window.focus();
      }
    };

    const protocolUrl = findProtocolUrl(argv);
    if (protocolUrl) {
      // OS 가 dolgate:// 인증 콜백을 전달하려고 앱을 다시 띄운 경우다. 새 창을 열지
      // 않고 콜백만 처리한 뒤 기존 창을 앞으로 가져온다.
      pendingAuthCallbackUrl = protocolUrl;
      if (app.isReady()) {
        void handleAuthCallbackUrl(protocolUrl);
      }
      focusExistingWindow();
      return;
    }

    // 크롬처럼 앱을 다시 실행하면(바로가기·시작 메뉴·작업 표시줄 점프리스트·exe 재실행)
    // 새 창을 연다. 단일 인스턴스 구조는 그대로다 — 두 번째 프로세스는 이 이벤트만
    // 넘기고 종료되고, 창 생성과 상태 공유는 이 메인 프로세스가 담당한다.
    if (app.isReady()) {
      void createWindow();
      return;
    }

    focusExistingWindow();
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
    rdpManager.shutdown();
    await sessionShareService.shutdown();
    await awsSsmTunnelService.shutdown();
    await coreManager.shutdown({ finalizePortForwardsAsStopped: true });
    hostsOverrideManager.clearStaticOverrideStates();
    await rewriteDnsOverridesForCurrentState().catch(() => undefined);
    if (context.purgeLocalData) {
      // 회원 탈퇴 — 이 기기의 로컬 흔적까지 지운다: 세션 리플레이 파일(scope 가 살아 있는
      // deactivate 이전에), 활동 로그, AI 자격증명 키. 호스트/시크릿/known hosts 등은
      // 아래 purgeSyncedCache 가 지운다.
      sessionReplayService.purgeAllRecordings();
      activityLogRepository.clear();
      for (const account of AI_STORED_KEY_SECRET_ACCOUNTS) {
        await secretStore.remove(account).catch(() => undefined);
      }
    }
    sessionReplayService.deactivate();
    activityLogRepository.deactivate();
    if (context.purgeSyncedCache) {
      await syncService.purgeSyncedCache();
      return;
    }
    syncService.pause(null);
  });

  app.whenReady().then(async () => {
    initMainI18n(settingsRepository.get().language, app.getLocale());
    // OS 키체인(보안 저장소)을 못 쓰면 저장된 시크릿 복호화가 전부 실패해 호스트/로그인이
    // 빈 상태로 뜬다(대표: 우분투 자동 로그인 → 키링 잠김 → basic_text 폴백). 조용히 빈
    // 화면을 보여주는 대신 원인을 안내하고 종료한다. (mac 의 isEncryptionAvailable 은
    // Keychain 존재 확인만 하는 즉시 반환이라 이 게이트로 권한 프롬프트가 뜨지 않는다.)
    if (!isSecureStorageUsable()) {
      dialog.showMessageBoxSync({
        type: 'error',
        title: t('mainApp.keychainTitle'),
        message:
          t('mainApp.keychainMessage'),
        detail:
          t('mainApp.keychainDetail'),
        buttons: [t('mainApp.ok')],
      });
      app.exit(1);
      return;
    }
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
      sessionReplayService,
      tailnetRepository,
      rdpManager,
      vncManager,
      {
        openWindow: async (intent) => {
          await createWindow(intent);
        },
        consumeLaunchIntent: (windowId) => {
          const intent = launchIntentsByWindowId.get(windowId) ?? null;
          launchIntentsByWindowId.delete(windowId);
          return intent;
        },
      },
    );
    registerNotificationsIpcHandlers(notificationService);
    await awsService.initializeManagedProfiles();
    await reconcileAwsHostProfileReferences();
    const openNewWindow = () => {
      void createWindow();
    };
    installApplicationMenu(openNewWindow);
    // 설정에서 언어를 바꾸면 메뉴 문구도 새 언어로 다시 만든다(라벨은 빌드 시점에 굽는다).
    onMainLocaleChanged(() => installApplicationMenu(openNewWindow));
    if (process.platform === 'win32') {
      // 작업 표시줄 아이콘 우클릭(점프리스트)에서 새 창을 열 수 있게 한다. 실행 중이면
      // --new-window 인자가 second-instance 로 전달돼 새 창이 열리고, 꺼져 있으면 앱이
      // 새로 시작된다. (아이콘 좌클릭은 OS 가 기존 창을 활성화하므로 여기서 잡히지 않는다.)
      app.setUserTasks([
        {
          program: process.execPath,
          arguments: '--new-window',
          title: t('mainApp.newWindow'),
          description: t('mainApp.newWindowDescription'),
          iconPath: process.execPath,
          iconIndex: 0,
        },
      ]);
    }
    if (process.platform === 'darwin') {
      app.dock?.setMenu(
        Menu.buildFromTemplate([
          {
            label: t('mainApp.newWindow'),
            click: openNewWindow,
          },
        ]),
      );
    }
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
      // 창만 닫았다 여는 동안에는 부팅 시 예약한 초기 확인이 다시 돌지 않는다.
      // 마지막 확인이 오래됐으면 이 시점에 업데이트를 다시 확인한다.
      updateService.checkIfStale();
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
    // 사이드카는 동기 종료라 비동기 정리 체인에 끼울 필요가 없다.
    rdpManager.shutdown();
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
