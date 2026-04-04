import type { DesktopApi } from '@shared';
import { desktopApi } from '../desktopApi';

type SshApi = DesktopApi['ssh'];

export function subscribeToTerminalData(
  sessionId: string,
  listener: Parameters<SshApi['onData']>[1],
) {
  return desktopApi.ssh.onData(sessionId, listener);
}

export function resizeTerminal(sessionId: string, cols: number, rows: number) {
  return desktopApi.ssh.resize(sessionId, cols, rows);
}

export function writeTerminalInput(sessionId: string, data: string) {
  return desktopApi.ssh.write(sessionId, data);
}

export function writeTerminalBinaryInput(sessionId: string, data: Uint8Array) {
  return desktopApi.ssh.writeBinary(sessionId, data);
}

export function openTerminalExternalUrl(url: string) {
  return desktopApi.shell.openExternal(url);
}
