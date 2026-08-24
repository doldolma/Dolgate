// 패널이 보는 세션과, 그 세션의 셸에 무언가 보내는 경로.
//
// 패널은 pane 밖(워크스페이스 레벨)에 있어 pane 컨트롤러의 ref 에 닿을 수 없다. 대신 컨트롤러가
// 등록해 둔 훅(terminal-write-registry)을 sessionId 로 찾아 쓴다 — AI 패널이 최근 출력을 읽는
// 방식과 같은 결이다.

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useAppStore } from '../../../store/appStore';
import { listWorkspaceSessionIds } from '../terminalWorkspaceLayout';
import {
  getCommandBlocks,
  getCommandBlocksVersion,
  subscribeToCommandBlocks,
} from '../../../lib/terminal-command-blocks';
import {
  hasLiveTerminal,
  isTerminalBracketedPasteEnabled,
  scrollTerminalToLine,
  sendTerminalInput,
} from '../../../lib/terminal-write-registry';
import {
  getShellHistory,
  getShellHistoryVersion,
  subscribeToShellHistory,
} from '../../../lib/shell-history-registry';
import {
  buildInsertPayload,
  buildRunPayload,
  isAtPrompt,
  type SessionPanelHistoryItem,
  type SessionPanelSendContext,
} from '../../../lib/session-panel';

/**
 * 이 세션의 명령 블록을 구독한다.
 *
 * 레지스트리는 배열을 제자리에서 바꾸므로(참조 불변) 스냅샷은 버전 숫자로 잡고, 버전이 오를
 * 때만 표시용 배열을 새로 만든다. 그래야 출력이 쏟아져도 리렌더가 명령 단위로만 일어난다.
 */
export function useSessionCommandBlocks(
  sessionId: string,
): readonly SessionPanelHistoryItem[] {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToCommandBlocks(sessionId, onChange),
    [sessionId],
  );
  const version = useSyncExternalStore(
    subscribe,
    () => getCommandBlocksVersion(sessionId),
    () => 0,
  );
  return useMemo(
    () =>
      getCommandBlocks(sessionId).map((block) => ({
        id: block.id,
        command: block.command,
        commandUnreliable: block.commandUnreliable,
        state: block.state,
        exitCode: block.exitCode,
        durationMs: block.durationMs,
        cwd: block.cwd,
        startedAt: block.startedAt,
        // 마커는 UI 로 넘기지 않는다 — 폐기 여부만 알면 되고, 객체를 들고 있으면 UI 가
        // 터미널 수명에 묶인다.
        line: block.marker.line,
      })),
    // version 이 스냅샷이다. eslint 가 "안 쓰는 의존성" 이라 볼 수 있지만 의도된 것이다.
    [sessionId, version],
  );
}

/**
 * 패널이 지금 볼 세션 — 늘 포커스된 pane 의 것이다. 없으면 패널을 그리지 않는다.
 *
 * 세션 셸(레이아웃)과 패널 본체가 **같은 답**을 봐야 한다 — 레이아웃은 "카드를 좌우로 나눌지"
 * 를, 본체는 "무엇을 그릴지" 를 이것으로 정한다. 따로 계산하면 카드는 나뉘었는데 패널이 없는
 * 상태가 생긴다.
 */
export function useSessionPanelTargetSessionId(
  activeSessionId: string | null,
): string | null {
  const open = useAppStore((state) => state.sessionPanelOpen);
  const tabs = useAppStore((state) => state.tabs);

  return useMemo(() => {
    if (!open || !activeSessionId) {
      return null;
    }
    // 셸이 있는 세션에서만 뜬다. RDP·VNC 에는 히스토리도 스니펫도 성립하지 않아, 절반이
    // 회색인 레일은 고장으로 읽힌다.
    const tab = tabs.find((item) => item.sessionId === activeSessionId);
    if (!tab || (tab.paneKind ?? 'terminal') !== 'terminal') {
      return null;
    }
    return activeSessionId;
  }, [activeSessionId, open, tabs]);
}

/**
 * 지표를 읽을 세션. **tmux pane 이면 그 창의 첫 pane** 이다.
 *
 * 지표 폴링은 세션(pane) 단위 레지스트리에 담기는데, tmux 는 pane 여럿이 control 세션 하나를
 * 공유하므로 pane 마다 돌리면 같은 호스트를 여러 번 찌른다. 그래서 창당 한 번만 돌리고 그
 * 값을 **첫 pane 키**로 발행한다(SessionShell 의 tmuxMetricsSessionId). 패널이 포커스된 pane
 * 키로 읽으면 첫 pane 이 아닐 때 빈 서랍을 열게 되어 `읽는 중` 으로 남았다 — 발행 쪽 키에
 * 맞춘다. 관찰 요청(주기 좁히기·프로세스 얹기)도 같은 키로 걸려야 듣는다.
 */
export function useSessionPanelMetricsSessionId(sessionId: string): string {
  const workspaces = useAppStore((state) => state.workspaces);

  return useMemo(() => {
    if (!sessionId) {
      return sessionId;
    }
    const workspace = workspaces.find((entry) =>
      listWorkspaceSessionIds(entry.layout).includes(sessionId),
    );
    if (!workspace?.tmux) {
      return sessionId;
    }
    return listWorkspaceSessionIds(workspace.layout)[0] ?? sessionId;
  }, [sessionId, workspaces]);
}

/**
 * 셸 자체의 히스토리(이 연결 전에 친 명령들).
 *
 * 자동완성이 연결할 때 받아 둔 스냅샷을 읽는다 — 원격에 다시 묻지 않는다. 스냅샷은 연결 뒤
 * 잠시 있다가 도착하므로 구독이 필요하다(그 전에 패널을 열면 이번 세션 것만 보인다).
 */
export function useSessionShellHistory(sessionId: string): readonly string[] {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToShellHistory(sessionId, onChange),
    [sessionId],
  );
  const version = useSyncExternalStore(
    subscribe,
    () => getShellHistoryVersion(sessionId),
    () => 0,
  );
  return useMemo(
    () => getShellHistory(sessionId),
    // version 이 스냅샷이다.
    [sessionId, version],
  );
}

export interface SessionPanelSender {
  context: SessionPanelSendContext;
  /** 입력줄에 넣는다(엔터 없음). 보낼 수 없으면 false. */
  insert: (command: string) => boolean;
  /** 넣고 엔터. */
  run: (command: string) => boolean;
  copy: (command: string) => void;
  jumpToLine: (line: number) => void;
}

export function useSessionPanelSender(
  sessionId: string,
  blocks: readonly SessionPanelHistoryItem[],
): SessionPanelSender {
  // 괄호 붙여넣기 모드는 전체화면 프로그램이 드나들 때 바뀌므로 렌더마다 읽는다. 클릭 시점에
  // 다시 확인하는 것은 buildInsertPayload 가 맡는다(그때 꺼져 있으면 null → 안 보낸다).
  const bracketedPaste = isTerminalBracketedPasteEnabled(sessionId);
  // 끊긴 세션에서도 히스토리는 남아 있고 볼 수 있다 — 다만 보낼 곳이 없으므로 프롬프트에
  // 있는 것으로 취급하지 않는다(복사는 그대로 된다).
  const atPrompt = hasLiveTerminal(sessionId) && isAtPrompt(blocks);
  const context = useMemo(
    () => ({ atPrompt, bracketedPaste }),
    [atPrompt, bracketedPaste],
  );

  const insert = useCallback(
    (command: string) => {
      const payload = buildInsertPayload(command, {
        bracketedPaste: isTerminalBracketedPasteEnabled(sessionId),
      });
      if (payload === null) {
        return false;
      }
      return sendTerminalInput(sessionId, payload);
    },
    [sessionId],
  );

  const run = useCallback(
    (command: string) => sendTerminalInput(sessionId, buildRunPayload(command)),
    [sessionId],
  );

  const copy = useCallback((command: string) => {
    // clipboard API 가 없는 환경(보안 컨텍스트가 아닌 창·테스트)에서 던지지 않게 한다 —
    // 던지면 호출한 쪽의 "복사했습니다" 표시까지 함께 죽는다.
    void navigator.clipboard?.writeText(command)?.catch(() => undefined);
  }, []);

  const jumpToLine = useCallback(
    (line: number) => {
      if (line < 0) {
        return;
      }
      scrollTerminalToLine(sessionId, line);
    },
    [sessionId],
  );

  return { context, insert, run, copy, jumpToLine };
}
