import { contextBridge, ipcRenderer } from 'electron';
import type {
  CoreEvent,
  DesktopApi,
  DesktopConnectInput,
  DesktopSftpConnectInput,
  HostDraft,
  HostSecretInput,
  SftpDeleteInput,
  SftpListInput,
  SftpMkdirInput,
  SftpRenameInput,
  TransferJobEvent,
  TransferStartInput
} from '@keyterm/shared';
import { ipcChannels } from '../common/ipc-channels';

const streamListeners = new Map<string, Set<(chunk: Uint8Array) => void>>();
const sessionBacklog = new Map<string, Uint8Array[]>();
const backlogBytes = new Map<string, number>();
const transferListeners = new Set<(event: TransferJobEvent) => void>();
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

// preload는 renderer에 필요한 최소 기능만 안전하게 노출하는 보안 경계다.
const api: DesktopApi = {
  hosts: {
    list: () => ipcRenderer.invoke(ipcChannels.hosts.list),
    create: (draft: HostDraft, secrets?: HostSecretInput) => ipcRenderer.invoke(ipcChannels.hosts.create, draft, secrets),
    update: (id: string, draft: HostDraft, secrets?: HostSecretInput) => ipcRenderer.invoke(ipcChannels.hosts.update, id, draft, secrets),
    remove: (id: string) => ipcRenderer.invoke(ipcChannels.hosts.remove, id)
  },
  groups: {
    list: () => ipcRenderer.invoke(ipcChannels.groups.list),
    create: (name: string, parentPath?: string | null) => ipcRenderer.invoke(ipcChannels.groups.create, name, parentPath)
  },
  ssh: {
    connect: (input: DesktopConnectInput) => ipcRenderer.invoke(ipcChannels.ssh.connect, input),
    write: (sessionId: string, data: string) => ipcRenderer.invoke(ipcChannels.ssh.write, sessionId, data),
    writeBinary: (sessionId: string, data: Uint8Array) => ipcRenderer.invoke(ipcChannels.ssh.writeBinary, sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke(ipcChannels.ssh.resize, sessionId, cols, rows),
    disconnect: (sessionId: string) => ipcRenderer.invoke(ipcChannels.ssh.disconnect, sessionId),
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
    pickPrivateKey: () => ipcRenderer.invoke(ipcChannels.shell.pickPrivateKey)
  },
  tabs: {
    list: () => ipcRenderer.invoke(ipcChannels.tabs.list)
  },
  settings: {
    get: () => ipcRenderer.invoke(ipcChannels.settings.get),
    update: (input) => ipcRenderer.invoke(ipcChannels.settings.update, input)
  },
  files: {
    getHomeDirectory: () => ipcRenderer.invoke(ipcChannels.files.getHomeDirectory),
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

// window.keyterm 하나만 renderer에 공개해서 표면적을 작게 유지한다.
contextBridge.exposeInMainWorld('keyterm', api);
