import type { DesktopApi } from '@shared';
import { desktopApi } from '../desktopApi';
import { resolveSessionIOHandler } from '../../lib/session-io';

type SshApi = DesktopApi['ssh'];

export function subscribeToTerminalData(
  sessionId: string,
  listener: Parameters<SshApi['onData']>[1],
) {
  return desktopApi.ssh.onData(sessionId, listener);
}

export function resizeTerminal(sessionId: string, cols: number, rows: number) {
  const handler = resolveSessionIOHandler(sessionId);
  if (handler) return Promise.resolve(handler.resize(cols, rows));
  return desktopApi.ssh.resize(sessionId, cols, rows);
}

export function writeTerminalInput(sessionId: string, data: string) {
  const handler = resolveSessionIOHandler(sessionId);
  if (handler) return Promise.resolve(handler.write(data));
  return desktopApi.ssh.write(sessionId, data);
}

export function writeTerminalBinaryInput(sessionId: string, data: Uint8Array) {
  const handler = resolveSessionIOHandler(sessionId);
  if (handler) return Promise.resolve(handler.writeBinary(data));
  return desktopApi.ssh.writeBinary(sessionId, data);
}

export function prepareTerminalAutocomplete(sessionId: string) {
  return desktopApi.ssh.prepareAutocomplete(sessionId);
}

export function refreshTerminalAutocomplete(sessionId: string) {
  return desktopApi.ssh.refreshAutocomplete(sessionId);
}

export function installTerminalShellIntegration(sessionId: string) {
  return desktopApi.ssh.installShellIntegration(sessionId);
}

export function stopTerminalAutocomplete(sessionId: string) {
  return desktopApi.ssh.stopAutocomplete(sessionId);
}

export function queryTerminalCompletion(sessionId: string, command: string) {
  return desktopApi.ssh.queryCompletion(sessionId, command);
}

export function tmuxSplitPane(sessionId: string, direction: 'h' | 'v') {
  return desktopApi.ssh.tmuxSplitPane(sessionId, direction);
}

export function tmuxNewWindow(sessionId: string) {
  return desktopApi.ssh.tmuxNewWindow(sessionId);
}

export function tmuxSelectWindow(sessionId: string, windowId: string) {
  return desktopApi.ssh.tmuxSelectWindow(sessionId, windowId);
}

export function tmuxSelectPane(sessionId: string) {
  return desktopApi.ssh.tmuxSelectPane(sessionId);
}

export function tmuxKillPane(sessionId: string) {
  return desktopApi.ssh.tmuxKillPane(sessionId);
}

export function tmuxKillWindow(sessionId: string, windowId: string) {
  return desktopApi.ssh.tmuxKillWindow(sessionId, windowId);
}

export function tmuxKillSession(sessionId: string, sessionName: string) {
  return desktopApi.ssh.tmuxKillSession(sessionId, sessionName);
}

export function tmuxRenameWindow(
  sessionId: string,
  windowId: string,
  name: string,
) {
  return desktopApi.ssh.tmuxRenameWindow(sessionId, windowId, name);
}

export function tmuxDetach(sessionId: string) {
  return desktopApi.ssh.tmuxDetach(sessionId);
}

export function subscribeToTerminalEvents(
  listener: Parameters<SshApi['onEvent']>[0],
) {
  return desktopApi.ssh.onEvent(listener);
}

export function openTerminalExternalUrl(url: string) {
  return desktopApi.shell.openExternal(url);
}
