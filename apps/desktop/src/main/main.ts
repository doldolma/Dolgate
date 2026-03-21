import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GroupRepository, HostRepository, SettingsRepository } from './database';
import { CoreManager } from './core-manager';
import { registerIpcHandlers } from './ipc';
import { SecretStore } from './secret-store';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// main 프로세스에서 공유하는 런타임 인스턴스들이다.
const hostRepository = new HostRepository();
const groupRepository = new GroupRepository();
const settingsRepository = new SettingsRepository();
const secretStore = new SecretStore();
const coreManager = new CoreManager();
let isQuitting = false;

async function createWindow(): Promise<void> {
  // renderer는 항상 preload를 거쳐서만 시스템 기능을 사용하게 강제한다.
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
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
  await coreManager.start();

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    // 개발 모드에서는 Vite dev server를 로드한다.
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    // 패키징 이후에는 번들된 정적 파일을 로드한다.
    await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

app.whenReady().then(async () => {
  // 앱 준비 이후에만 IPC와 창 생성을 시작한다.
  registerIpcHandlers(hostRepository, groupRepository, settingsRepository, secretStore, coreManager);
  await createWindow();

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
    app.quit();
  });
});

app.on('window-all-closed', () => {
  // macOS 관례를 따라 darwin 외 플랫폼에서만 앱을 완전히 종료한다.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
