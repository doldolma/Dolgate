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

/**
 * 보조 채널에서 짧은 read-only 명령을 돌리고 stdout 을 받는다.
 *
 * 스스로 도는 폴링(세션 패널의 도커·호스트 지표)은 `{ background: true }` 로 부른다 — 그러면
 * 두 번째 보조 채널에서 돌아, 몇 초씩 걸리는 왕복 뒤에 사용자가 치는 자동완성이 줄 서지 않는다.
 * 사람이 결과를 기다리는 질의(자동완성)는 그냥 부른다.
 */
export async function queryTerminalCompletion(
  sessionId: string,
  command: string,
  options?: { background?: boolean; elevate?: boolean },
): Promise<string> {
  const result = await desktopApi.ssh.queryCompletion(sessionId, command, options);
  // 실패는 결과에 담겨 온다(IPC 거부로 보내면 메인 로그가 오류로 뒤덮인다) — 여기서 예외로
  // 바꿔 호출부가 하던 대로 catch 하게 한다. 명령이 아무것도 안 찍은 것은 실패가 아니다.
  if (result.failed) {
    throw new Error(result.message ?? '보조 채널에서 명령을 끝내지 못했습니다.');
  }
  return result.stdout;
}

/**
 * 코어가 이 기계의 자원을 직접 읽어 돌려준다(로컬 세션 전용).
 *
 * `supported: false` 는 실패가 아니라 답이다 — 이 플랫폼이나 세션 유형에서는 네이티브로
 * 읽지 않으니 셸 경로로 돌아가라는 뜻이다. 호출부가 그 판정을 세션 단위로 기억한다.
 */
export async function collectNativeHostMetrics(
  sessionId: string,
  options?: { processLimit?: number; system?: boolean },
): Promise<{ supported: boolean; sample: unknown | null }> {
  const result = await desktopApi.ssh.collectHostMetrics(sessionId, options);
  return { supported: result.supported === true, sample: result.sample ?? null };
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

// refreshTmuxSessions 는 tmux 세션 목록을 즉시 다시 읽힌다(드롭다운 열 때·새로고침 버튼).
//
// **control 채널로 직접 보내지 않는다.** 예전에는 control 명령(`__dolssh_refresh_sessions__`)을
// 보냈는데, attach 전 감지 상태에는 control 채널이 없어 조용히 무시됐다 — 목록은 접속 시
// 스냅샷에 멈춰 있고 버튼은 눌리는 느낌만 났다. 이제 코어가 세션 종류를 보고 통로를 고른다.
export function refreshTmuxSessions(sessionId: string) {
  return desktopApi.ssh.tmuxRefreshSessions(sessionId);
}

export function subscribeToTerminalEvents(
  listener: Parameters<SshApi['onEvent']>[0],
) {
  return desktopApi.ssh.onEvent(listener);
}

export function openTerminalExternalUrl(url: string) {
  return desktopApi.shell.openExternal(url);
}
