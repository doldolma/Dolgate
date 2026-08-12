import type { AppSettings, DesktopWindowLaunchIntent } from "@shared";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { app, dialog, ipcMain, shell } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import { applyMainLanguage } from "../i18n";
import type { MainIpcContext } from "./context";

export interface DesktopWindowIpcRuntime {
  openWindow: (intent?: DesktopWindowLaunchIntent) => Promise<void>;
  consumeLaunchIntent: (windowId: number) => DesktopWindowLaunchIntent | null;
}

export function registerWindowUpdaterSettingsFilesIpcHandlers(
  ctx: MainIpcContext,
  windowRuntime?: DesktopWindowIpcRuntime,
): void {
  ipcMain.handle(ipcChannels.window.getState, async (event) =>
    ctx.buildWindowState(ctx.resolveWindowFromSender(event.sender)),
  );

  ipcMain.handle(ipcChannels.window.openNew, async () => {
    await windowRuntime?.openWindow();
  });

  ipcMain.handle(
    ipcChannels.window.openHost,
    async (_event, hostId: string) => {
      if (typeof hostId !== "string" || !ctx.hosts.getById(hostId)) {
        throw new Error("Host not found");
      }
      await windowRuntime?.openWindow({ type: "connect-host", hostId });
    },
  );

  ipcMain.handle(ipcChannels.window.consumeLaunchIntent, async (event) => {
    const window = ctx.resolveWindowFromSender(event.sender);
    return windowRuntime?.consumeLaunchIntent(window.id) ?? null;
  });

  ipcMain.handle(ipcChannels.window.minimize, async (event) => {
    ctx.resolveWindowFromSender(event.sender).minimize();
  });

  ipcMain.handle(ipcChannels.window.maximize, async (event) => {
    ctx.resolveWindowFromSender(event.sender).maximize();
  });

  ipcMain.handle(ipcChannels.window.restore, async (event) => {
    ctx.resolveWindowFromSender(event.sender).restore();
  });

  // 토글을 메인에서 판정한다. 렌더러가 "지금 전체화면인가" 를 들고 와서 반대로 세팅하면, 그 값이
  // 낡았을 때(F11 로 이미 바뀐 직후 등) 같은 상태를 다시 세팅해 버튼이 먹지 않는다.
  ipcMain.handle(ipcChannels.window.toggleFullScreen, async (event) => {
    const window = ctx.resolveWindowFromSender(event.sender);
    const wasFullScreen = window.isFullScreen();

    // **최대화 상태에서 곧바로 전체화면으로 넘기지 않는다.** 실측으로 확인한 동작이다
    // (Windows 11, Electron 42, frame:false):
    //
    //   최대화된 창에 setFullScreen(true) → 화면은 그대로인데 isFullScreen() 만 true 가 되고
    //   enter-full-screen 이 오지 않는다. 상단바는 그 사실을 모르니 탭이 그대로 보이고, 나중에
    //   창을 되돌리면 unmaximize 이벤트에 실려 온 "여전히 true" 를 보고 작은 창에서 탭이 사라진다.
    //   그 뒤로는 아이콘도 계속 "전체화면 종료" 에 머문다.
    //
    // 최대화를 먼저 풀어 정상 창 상태에서 전이시키면 전이와 이벤트가 모두 제대로 일어난다.
    if (!wasFullScreen && window.isMaximized()) {
      window.unmaximize();
    }
    window.setFullScreen(!wasFullScreen);
  });

  ipcMain.handle(ipcChannels.window.close, async (event) => {
    ctx.resolveWindowFromSender(event.sender).close();
  });

  ipcMain.handle(ipcChannels.tabs.list, async (event) =>
    ctx.coreManager.listTabs(event.sender.id),
  );

  ipcMain.handle(ipcChannels.updater.getState, async () => ctx.updater.getState());

  ipcMain.handle(ipcChannels.updater.check, async () => {
    await ctx.updater.check();
  });

  ipcMain.handle(ipcChannels.updater.download, async () => {
    await ctx.updater.download();
  });

  ipcMain.handle(ipcChannels.updater.installAndRestart, async () => {
    await ctx.updater.installAndRestart();
  });

  ipcMain.handle(
    ipcChannels.updater.dismissAvailable,
    async (_event, version: string) => {
      await ctx.updater.dismissAvailable(version);
    },
  );

  ipcMain.handle(ipcChannels.settings.get, async () => ctx.settings.get());

  ipcMain.handle(
    ipcChannels.settings.update,
    async (event, input: Partial<AppSettings>) => {
      const previousServerUrl = ctx.settings.get().serverUrl;
      const previousTailnetHostname = ctx.settings.get().tailnetHostname ?? null;
      const nextSettings = ctx.settings.update(input);
      // 노드 이름은 코어가 노드를 만들 때 쓴다. 다시 밀어 넣지 않으면 앱을 재시작할 때까지
      // 코어가 옛 이름을 들고 있다. 이름만 바뀐 변경은 노드를 버리지 않으므로 이 호출로
      // 끊기는 연결은 없다.
      if ((nextSettings.tailnetHostname ?? null) !== previousTailnetHostname) {
        ctx.coreManager.pushTailnetConfigs();
      }
      if (Object.prototype.hasOwnProperty.call(input, "language")) {
        applyMainLanguage(nextSettings.language);
      }
      if (nextSettings.serverUrl !== previousServerUrl) {
        ctx.authService.resetServerVaultSupport();
        ctx.authService.resetServerWebauthnSupport();
      }
      if (
        Object.prototype.hasOwnProperty.call(
          input,
          "sessionReplayRetentionCount",
        )
      ) {
        ctx.sessionReplayService.prune();
      }
      ctx.emitWorkspaceChanged?.(event?.sender);
      return nextSettings;
    },
  );

  ipcMain.handle(ipcChannels.shell.pickPrivateKey, async () => {
    const result = await dialog.showOpenDialog({
      defaultPath: path.join(app.getPath("home"), ".ssh"),
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const filePath = result.filePaths[0];
    return {
      path: filePath,
      name: path.basename(filePath),
      content: await readFile(filePath, "utf8"),
    };
  });

  ipcMain.handle(ipcChannels.shell.pickSshCertificate, async () => {
    const result = await dialog.showOpenDialog({
      defaultPath: path.join(app.getPath("home"), ".ssh"),
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const filePath = result.filePaths[0];
    return {
      path: filePath,
      name: path.basename(filePath),
      content: await readFile(filePath, "utf8"),
    };
  });

  ipcMain.handle(ipcChannels.shell.pickOpenSshConfig, async () => {
    const result = await dialog.showOpenDialog({
      defaultPath: path.join(app.getPath("home"), ".ssh"),
      properties: ["openFile"],
      filters: [
        { name: "OpenSSH config", extensions: ["config", "conf"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(ipcChannels.shell.pickXshellSessionFolder, async () => {
    const result = await dialog.showOpenDialog({
      defaultPath: await ctx.xshellImportService.getPickerDefaultPath(),
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(ipcChannels.files.getHomeDirectory, async () =>
    ctx.localFiles.getHomeDirectory(),
  );
  ipcMain.handle(ipcChannels.files.getDownloadsDirectory, async () =>
    ctx.localFiles.getDownloadsDirectory(),
  );
  ipcMain.handle(ipcChannels.files.listRoots, async () =>
    ctx.localFiles.listRoots(),
  );
  ipcMain.handle(
    ipcChannels.files.getParentPath,
    async (_event, targetPath: string) => ctx.localFiles.getParentPath(targetPath),
  );

  ipcMain.handle(ipcChannels.files.list, async (_event, targetPath: string) =>
    ctx.localFiles.list(targetPath),
  );

  ipcMain.handle(
    ipcChannels.files.mkdir,
    async (_event, targetPath: string, name: string) => {
      await ctx.localFiles.mkdir(targetPath, name);
    },
  );

  ipcMain.handle(
    ipcChannels.files.rename,
    async (_event, targetPath: string, nextName: string) => {
      await ctx.localFiles.rename(targetPath, nextName);
    },
  );

  ipcMain.handle(
    ipcChannels.files.chmod,
    async (_event, targetPath: string, mode: number) => {
      await ctx.localFiles.chmod(targetPath, mode);
    },
  );

  ipcMain.handle(ipcChannels.files.delete, async (_event, paths: string[]) => {
    await ctx.localFiles.delete(paths);
  });

  ipcMain.handle(
    ipcChannels.files.saveZmodemDownload,
    async (_event, input: { name: string; bytes: Uint8Array }) => {
      const savedPath = await ctx.localFiles.saveToDownloads(
        input.name,
        input.bytes,
      );
      return { savedPath };
    },
  );

  ipcMain.handle(
    ipcChannels.files.reveal,
    async (_event, targetPath: string) => {
      shell.showItemInFolder(targetPath);
    },
  );
}
