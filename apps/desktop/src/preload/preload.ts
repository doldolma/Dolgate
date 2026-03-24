import { contextBridge, ipcRenderer } from 'electron';
import type {
  AuthState,
  CoreEvent,
  DesktopApi,
  DesktopConnectInput,
  DesktopSftpConnectInput,
  DesktopWindowState,
  HostDraft,
  HostSecretInput,
  GroupRemoveMode,
  KeyboardInteractiveRespondInput,
  KeychainSecretCloneInput,
  KeychainSecretUpdateInput,
  KnownHostProbeInput,
  KnownHostTrustInput,
  PortForwardDraft,
  PortForwardRuntimeEvent,
  SftpDeleteInput,
  SftpListInput,
  SftpMkdirInput,
  SftpRenameInput,
  UpdateEvent,
  TransferJobEvent,
  TransferStartInput
} from '@shared';
import { ipcChannels } from '../common/ipc-channels';

const streamListeners = new Map<string, Set<(chunk: Uint8Array) => void>>();
const sessionBacklog = new Map<string, Uint8Array[]>();
const backlogBytes = new Map<string, number>();
const transferListeners = new Set<(event: TransferJobEvent) => void>();
const portForwardListeners = new Set<(event: PortForwardRuntimeEvent) => void>();
const updateListeners = new Set<(event: UpdateEvent) => void>();
const authListeners = new Set<(state: AuthState) => void>();
const windowStateListeners = new Set<(state: DesktopWindowState) => void>();
const MAX_SESSION_BACKLOG_BYTES = 1024 * 1024;

function cloneChunk(chunk: Uint8Array): Uint8Array {
  return new Uint8Array(chunk);
}

function appendBacklog(sessionId: string, chunk: Uint8Array): void {
  const queue = sessionBacklog.get(sessionId) ?? [];
  queue.push(cloneChunk(chunk));
  sessionBacklog.set(sessionId, queue);

  const nextBytes = (backlogBytes.get(sessionId) ?? 0) + chunk.byteLength;
  backlogBytes.set(sessionId, nextBytes);

  let currentBytes = backlogBytes.get(sessionId) ?? 0;
  while (currentBytes > MAX_SESSION_BACKLOG_BYTES && queue.length > 1) {
    const removed = queue.shift();
    if (!removed) {
      break;
    }
    currentBytes -= removed.byteLength;
  }
  backlogBytes.set(sessionId, currentBytes);
}

ipcRenderer.on(ipcChannels.ssh.event, (_event, payload: CoreEvent) => {
  if (payload.type === 'closed' && payload.sessionId) {
    sessionBacklog.delete(payload.sessionId);
    backlogBytes.delete(payload.sessionId);
  }
});

ipcRenderer.on(ipcChannels.ssh.data, (_event, payload: { sessionId: string; chunk: Uint8Array }) => {
  appendBacklog(payload.sessionId, payload.chunk);
  const listeners = streamListeners.get(payload.sessionId);
  if (!listeners || listeners.size === 0) {
    return;
  }
  for (const listener of listeners) {
    listener(payload.chunk);
  }
});

ipcRenderer.on(ipcChannels.sftp.transferEvent, (_event, payload: TransferJobEvent) => {
  for (const listener of transferListeners) {
    listener(payload);
  }
});

ipcRenderer.on(ipcChannels.portForwards.event, (_event, payload: PortForwardRuntimeEvent) => {
  for (const listener of portForwardListeners) {
    listener(payload);
  }
});

ipcRenderer.on(ipcChannels.updater.event, (_event, payload: UpdateEvent) => {
  for (const listener of updateListeners) {
    listener(payload);
  }
});

ipcRenderer.on(ipcChannels.auth.event, (_event, payload: AuthState) => {
  for (const listener of authListeners) {
    listener(payload);
  }
});

ipcRenderer.on(ipcChannels.window.stateChanged, (_event, payload: DesktopWindowState) => {
  for (const listener of windowStateListeners) {
    listener(payload);
  }
});

// preload는 renderer에 필요한 최소 기능만 안전하게 노출하는 보안 경계다.
const api: DesktopApi = {
  auth: {
    getState: () => ipcRenderer.invoke(ipcChannels.auth.getState),
    bootstrap: () => ipcRenderer.invoke(ipcChannels.auth.bootstrap),
    beginBrowserLogin: () => ipcRenderer.invoke(ipcChannels.auth.beginBrowserLogin),
    logout: () => ipcRenderer.invoke(ipcChannels.auth.logout),
    onEvent: (listener: (state: AuthState) => void) => {
      authListeners.add(listener);
      return () => {
        authListeners.delete(listener);
      };
    }
  },
  sync: {
    bootstrap: () => ipcRenderer.invoke(ipcChannels.sync.bootstrap),
    pushDirty: () => ipcRenderer.invoke(ipcChannels.sync.pushDirty),
    status: () => ipcRenderer.invoke(ipcChannels.sync.status),
    exportDecryptedSnapshot: () => ipcRenderer.invoke(ipcChannels.sync.exportDecryptedSnapshot)
  },
  hosts: {
    list: () => ipcRenderer.invoke(ipcChannels.hosts.list),
    create: (draft: HostDraft, secrets?: HostSecretInput) => ipcRenderer.invoke(ipcChannels.hosts.create, draft, secrets),
    update: (id: string, draft: HostDraft, secrets?: HostSecretInput) => ipcRenderer.invoke(ipcChannels.hosts.update, id, draft, secrets),
    remove: (id: string) => ipcRenderer.invoke(ipcChannels.hosts.remove, id)
  },
  groups: {
    list: () => ipcRenderer.invoke(ipcChannels.groups.list),
    create: (name: string, parentPath?: string | null) => ipcRenderer.invoke(ipcChannels.groups.create, name, parentPath),
    remove: (path: string, mode: GroupRemoveMode) => ipcRenderer.invoke(ipcChannels.groups.remove, path, mode)
  },
  aws: {
    listProfiles: () => ipcRenderer.invoke(ipcChannels.aws.listProfiles),
    getProfileStatus: (profileName: string) => ipcRenderer.invoke(ipcChannels.aws.getProfileStatus, profileName),
    login: (profileName: string) => ipcRenderer.invoke(ipcChannels.aws.login, profileName),
    listRegions: (profileName: string) => ipcRenderer.invoke(ipcChannels.aws.listRegions, profileName),
    listEc2Instances: (profileName: string, region: string) => ipcRenderer.invoke(ipcChannels.aws.listEc2Instances, profileName, region)
  },
  warpgate: {
    testConnection: (baseUrl: string, token: string) => ipcRenderer.invoke(ipcChannels.warpgate.testConnection, baseUrl, token),
    getConnectionInfo: (baseUrl: string, token: string) => ipcRenderer.invoke(ipcChannels.warpgate.getConnectionInfo, baseUrl, token),
    listSshTargets: (baseUrl: string, token: string) => ipcRenderer.invoke(ipcChannels.warpgate.listSshTargets, baseUrl, token)
  },
  termius: {
    probeLocal: () => ipcRenderer.invoke(ipcChannels.termius.probeLocal),
    importSelection: (input) => ipcRenderer.invoke(ipcChannels.termius.importSelection, input),
    discardSnapshot: (snapshotId: string) => ipcRenderer.invoke(ipcChannels.termius.discardSnapshot, snapshotId)
  },
  ssh: {
    connect: (input: DesktopConnectInput) => ipcRenderer.invoke(ipcChannels.ssh.connect, input),
    write: (sessionId: string, data: string) => ipcRenderer.invoke(ipcChannels.ssh.write, sessionId, data),
    writeBinary: (sessionId: string, data: Uint8Array) => ipcRenderer.invoke(ipcChannels.ssh.writeBinary, sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke(ipcChannels.ssh.resize, sessionId, cols, rows),
    disconnect: (sessionId: string) => ipcRenderer.invoke(ipcChannels.ssh.disconnect, sessionId),
    respondKeyboardInteractive: (input: KeyboardInteractiveRespondInput) => ipcRenderer.invoke(ipcChannels.ssh.respondKeyboardInteractive, input),
    onEvent: (listener: (event: CoreEvent) => void) => {
      // 구독 해제 함수를 함께 반환해서 React effect cleanup과 자연스럽게 맞춘다.
      const wrapped = (_event: Electron.IpcRendererEvent, payload: CoreEvent) => listener(payload);
      ipcRenderer.on(ipcChannels.ssh.event, wrapped);
      return () => {
        ipcRenderer.removeListener(ipcChannels.ssh.event, wrapped);
      };
    },
    onData: (sessionId: string, listener: (chunk: Uint8Array) => void) => {
      const listeners = streamListeners.get(sessionId) ?? new Set<(chunk: Uint8Array) => void>();
      listeners.add(listener);
      streamListeners.set(sessionId, listeners);

      const queued = sessionBacklog.get(sessionId) ?? [];
      for (const chunk of queued) {
        listener(chunk);
      }

      return () => {
        const currentListeners = streamListeners.get(sessionId);
        if (!currentListeners) {
          return;
        }
        currentListeners.delete(listener);
        if (currentListeners.size === 0) {
          streamListeners.delete(sessionId);
        }
      };
    }
  },
  shell: {
    pickPrivateKey: () => ipcRenderer.invoke(ipcChannels.shell.pickPrivateKey),
    openExternal: (url: string) => ipcRenderer.invoke(ipcChannels.shell.openExternal, url)
  },
  window: {
    getState: () => ipcRenderer.invoke(ipcChannels.window.getState),
    minimize: () => ipcRenderer.invoke(ipcChannels.window.minimize),
    maximize: () => ipcRenderer.invoke(ipcChannels.window.maximize),
    restore: () => ipcRenderer.invoke(ipcChannels.window.restore),
    close: () => ipcRenderer.invoke(ipcChannels.window.close),
    onStateChanged: (listener: (state: DesktopWindowState) => void) => {
      windowStateListeners.add(listener);
      return () => {
        windowStateListeners.delete(listener);
      };
    }
  },
  tabs: {
    list: () => ipcRenderer.invoke(ipcChannels.tabs.list)
  },
  updater: {
    getState: () => ipcRenderer.invoke(ipcChannels.updater.getState),
    check: () => ipcRenderer.invoke(ipcChannels.updater.check),
    download: () => ipcRenderer.invoke(ipcChannels.updater.download),
    installAndRestart: () => ipcRenderer.invoke(ipcChannels.updater.installAndRestart),
    dismissAvailable: (version: string) => ipcRenderer.invoke(ipcChannels.updater.dismissAvailable, version),
    onEvent: (listener) => {
      updateListeners.add(listener);
      return () => {
        updateListeners.delete(listener);
      };
    }
  },
  settings: {
    get: () => ipcRenderer.invoke(ipcChannels.settings.get),
    update: (input) => ipcRenderer.invoke(ipcChannels.settings.update, input)
  },
  portForwards: {
    list: () => ipcRenderer.invoke(ipcChannels.portForwards.list),
    create: (draft: PortForwardDraft) => ipcRenderer.invoke(ipcChannels.portForwards.create, draft),
    update: (id: string, draft: PortForwardDraft) => ipcRenderer.invoke(ipcChannels.portForwards.update, id, draft),
    remove: (id: string) => ipcRenderer.invoke(ipcChannels.portForwards.remove, id),
    start: (ruleId: string) => ipcRenderer.invoke(ipcChannels.portForwards.start, ruleId),
    stop: (ruleId: string) => ipcRenderer.invoke(ipcChannels.portForwards.stop, ruleId),
    onEvent: (listener: (event: PortForwardRuntimeEvent) => void) => {
      portForwardListeners.add(listener);
      return () => {
        portForwardListeners.delete(listener);
      };
    }
  },
  knownHosts: {
    list: () => ipcRenderer.invoke(ipcChannels.knownHosts.list),
    probeHost: (input: KnownHostProbeInput) => ipcRenderer.invoke(ipcChannels.knownHosts.probeHost, input),
    trust: (input: KnownHostTrustInput) => ipcRenderer.invoke(ipcChannels.knownHosts.trust, input),
    replace: (input: KnownHostTrustInput) => ipcRenderer.invoke(ipcChannels.knownHosts.replace, input),
    remove: (id: string) => ipcRenderer.invoke(ipcChannels.knownHosts.remove, id)
  },
  logs: {
    list: () => ipcRenderer.invoke(ipcChannels.logs.list),
    clear: () => ipcRenderer.invoke(ipcChannels.logs.clear)
  },
  keychain: {
    list: () => ipcRenderer.invoke(ipcChannels.keychain.list),
    load: (secretRef: string) => ipcRenderer.invoke(ipcChannels.keychain.load, secretRef),
    remove: (secretRef: string) => ipcRenderer.invoke(ipcChannels.keychain.remove, secretRef),
    update: (input: KeychainSecretUpdateInput) => ipcRenderer.invoke(ipcChannels.keychain.update, input),
    cloneForHost: (input: KeychainSecretCloneInput) => ipcRenderer.invoke(ipcChannels.keychain.cloneForHost, input)
  },
  files: {
    getHomeDirectory: () => ipcRenderer.invoke(ipcChannels.files.getHomeDirectory),
    getParentPath: (targetPath: string) => ipcRenderer.invoke(ipcChannels.files.getParentPath, targetPath),
    list: (path: string) => ipcRenderer.invoke(ipcChannels.files.list, path),
    mkdir: (path: string, name: string) => ipcRenderer.invoke(ipcChannels.files.mkdir, path, name),
    rename: (path: string, nextName: string) => ipcRenderer.invoke(ipcChannels.files.rename, path, nextName),
    delete: (paths: string[]) => ipcRenderer.invoke(ipcChannels.files.delete, paths)
  },
  sftp: {
    connect: (input: DesktopSftpConnectInput) => ipcRenderer.invoke(ipcChannels.sftp.connect, input),
    disconnect: (endpointId: string) => ipcRenderer.invoke(ipcChannels.sftp.disconnect, endpointId),
    list: (input: SftpListInput) => ipcRenderer.invoke(ipcChannels.sftp.list, input),
    mkdir: (input: SftpMkdirInput) => ipcRenderer.invoke(ipcChannels.sftp.mkdir, input),
    rename: (input: SftpRenameInput) => ipcRenderer.invoke(ipcChannels.sftp.rename, input),
    delete: (input: SftpDeleteInput) => ipcRenderer.invoke(ipcChannels.sftp.delete, input),
    startTransfer: (input: TransferStartInput) => ipcRenderer.invoke(ipcChannels.sftp.startTransfer, input),
    cancelTransfer: (jobId: string) => ipcRenderer.invoke(ipcChannels.sftp.cancelTransfer, jobId),
    onTransferEvent: (listener: (event: TransferJobEvent) => void) => {
      transferListeners.add(listener);
      return () => {
        transferListeners.delete(listener);
      };
    }
  }
};

// window.dolssh 하나만 renderer에 공개해서 표면적을 작게 유지한다.
contextBridge.exposeInMainWorld('dolssh', api);
