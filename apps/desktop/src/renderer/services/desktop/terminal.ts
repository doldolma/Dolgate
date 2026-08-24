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

export function reinjectTerminalShellIntegration(sessionId: string, shell?: string) {
  return desktopApi.ssh.reinjectShellIntegration(sessionId, shell);
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

// tmuxCommand 는 렌더러 키맵이 만든 tmux 명령을 control 채널로 그대로 보낸다(단축키 확장용).
export function tmuxCommand(sessionId: string, command: string) {
  return desktopApi.ssh.tmuxCommand(sessionId, command);
}

// Go ControlCommand 의 RefreshSessionsCommand 와 같은 값이어야 한다(세션 목록 즉시 재조회).
const TMUX_REFRESH_SESSIONS = '__dolssh_refresh_sessions__';

// refreshTmuxSessions 는 control 세션의 tmux 세션 목록을 즉시 재조회시킨다(드롭다운 열 때).
// %sessions-changed 가 다른 SSH 연결의 새 세션엔 안 오는 경우가 있어 명시적으로 pull.
export function refreshTmuxSessions(sessionId: string) {
  return desktopApi.ssh.tmuxCommand(sessionId, TMUX_REFRESH_SESSIONS);
}

export function subscribeToTerminalEvents(
  listener: Parameters<SshApi['onEvent']>[0],
) {
  return desktopApi.ssh.onEvent(listener);
}

export function openTerminalExternalUrl(url: string) {
  return desktopApi.shell.openExternal(url);
}
