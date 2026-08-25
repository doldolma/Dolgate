// 세션 패널의 골격. **지금 포커스된 세션(분할이면 그 pane)의 호스트**에 대한 것만 담는다.
//
// 왜 pane 안이 아니라 워크스페이스 레벨인가: 분할할 때마다 패널이 하나씩 늘면 화면이 패널로
// 가득 찬다. 하나만 두고 포커스를 따라간다.
//
// 창에 앉는 방식: 터미널 카드와 **한 판을 나눠 쓴다.** 바깥 라운드·테두리는 세션 셸의 래퍼가
// 그리고 여기서는 오른쪽 라운드와 가운데 구분선만 맡는다 — 라운드 카드 옆에 평평한 띠가
// 붙으면 그것만으로 덧붙인 화면처럼 보인다.
//
// v1 은 스니펫·히스토리 둘뿐이다. 둘을 고른 이유는 데이터 모양이 서로 달라서다 — 하나는 앱
// 상태만 읽고, 하나는 세션별 라이브 레지스트리를 구독한다. 이 둘이 돌면 나머지 섹션은 얹는
// 일이 된다.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/cn';
import { useAppStore } from '../../../store/appStore';
import {
  resolveDefaultSessionPanelSection,
  type SessionPanelSectionId,
} from '../../../lib/session-panel';
import {
  Activity,
  Cable,
  Columns2,
  Container,
  History,
  ListOrdered,
  Palette,
  RefreshCw,
  Scissors,
  Sparkles,
  X,
} from '../../../ui/icons';
import { Tooltip } from '../../../ui';
import { AiChatPanel } from '../AiChatPanel';
import { SessionPanelDocker } from './SessionPanelDocker';
import { SessionPanelHistory } from './SessionPanelHistory';
import { SessionPanelPorts } from './SessionPanelPorts';
import { SessionPanelProcesses } from './SessionPanelProcesses';
import { SessionPanelResources } from './SessionPanelResources';
import { SessionPanelSnippets } from './SessionPanelSnippets';
import { SessionPanelTheme } from './SessionPanelTheme';
import { SessionPanelTmux } from './SessionPanelTmux';
import { beginLayoutTransition } from '../../../lib/layout-transition';
import {
  requestDockerRefresh,
  useDockerBusy,
  useDockerRuntime,
} from './useSessionDocker';
import {
  SESSION_PANEL_MOTION_MS,
  useSessionCommandBlocks,
  useSessionPanelMetricsSessionId,
  useSessionPanelSender,
  useSessionShellHistory,
} from './useSessionPanelTarget';

interface SessionPanelProps {
  /** 패널이 볼 세션. null 이면 그리지 않는다(useSessionPanelTargetSessionId 가 정한다). */
  sessionId: string | null;
}

/**
 * 전환이 끝난 뒤 터미널 fit 을 돌리기까지의 여유(ms). 폭이 완전히 멈춘 뒤에 재게 한다.
 */
const MOTION_SETTLE_MS = 40;

/** 레일 폭(px). 저장하는 폭은 본문 폭이라 여기 값을 더해 전체 폭을 만든다. */
const RAIL_WIDTH_PX = 38;

const SECTIONS: Array<{
  id: SessionPanelSectionId;
  Icon: typeof History;
  labelKey: string;
}> = [
  { id: 'snippets', Icon: Scissors, labelKey: 'sessionPanel.snippets.title' },
  { id: 'history', Icon: History, labelKey: 'sessionPanel.history.title' },
  // AI 는 pane 헤더의 버튼에서 여기로 옮겼다. 세션에 딸린 것이 한 곳에 모여야 찾을 데가
  // 하나가 되고, 터미널 위에 뜨는 토글이 하나 줄어든다.
  { id: 'ai', Icon: Sparkles, labelKey: 'aiChat.title' },
  // 관측 묶음. 둘은 같은 폴링을 쓰므로 붙여 둔다.
  { id: 'resources', Icon: Activity, labelKey: 'sessionPanel.resources.title' },
  { id: 'processes', Icon: ListOrdered, labelKey: 'sessionPanel.processes.title' },
  { id: 'ports', Icon: Cable, labelKey: 'sessionPanel.ports.title' },
  // tmux. 하단바에는 상태 칩만 두고 세션 목록·생성·kill·detach 는 여기로 모았다.
  { id: 'tmux', Icon: Columns2, labelKey: 'sessionPanel.tmux.title' },
  // 도커. 다른 섹션과 같이 **늘 이 자리에 있다** — 안 되는 호스트에서는 섹션 안에서 이유를
  // 말한다(자원·프로세스가 그러는 것과 같다). 자리를 없애면 그것만 특별해진다.
  { id: 'docker', Icon: Container, labelKey: 'sessionPanel.docker.title' },
  // 테마는 맨 아래. 세션마다 여는 것이 아니라 한 번 정하고 마는 것이다.
  { id: 'theme', Icon: Palette, labelKey: 'sessionPanel.theme.title' },
];

const SECTION_TITLE_KEY: Record<SessionPanelSectionId, string> = {
  snippets: 'sessionPanel.snippets.title',
  history: 'sessionPanel.history.title',
  ai: 'aiChat.title',
  resources: 'sessionPanel.resources.title',
  processes: 'sessionPanel.processes.title',
  ports: 'sessionPanel.ports.title',
  tmux: 'sessionPanel.tmux.title',
  docker: 'sessionPanel.docker.title',
  theme: 'sessionPanel.theme.title',
};

const HEADER_BUTTON_CLASS =
  'grid h-6 w-6 shrink-0 place-items-center rounded-[7px] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text)]';

export function SessionPanel({ sessionId }: SessionPanelProps) {
  const { t: translate } = useTranslation();
  const togglePanel = useAppStore((state) => state.toggleSessionPanel);
  const open = useAppStore((state) => state.sessionPanelOpen);
  const width = useAppStore((state) => state.sessionPanelWidth);
  const setWidth = useAppStore((state) => state.setSessionPanelWidth);
  const sectionBySessionId = useAppStore(
    (state) => state.sessionPanelSectionBySessionId,
  );
  const selectSection = useAppStore((state) => state.selectSessionPanelSection);
  const clearAiConversation = useAppStore((state) => state.clearAiConversation);
  const tabs = useAppStore((state) => state.tabs);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  /**
   * 여닫는 전환 상태.
   *
   * `expanded` 는 폭의 목표값(0 ↔ 제 폭)이고, `moving` 은 전환이 도는 동안만 참이다.
   *
   * 왜 두 개인가: 폭이 움직이는 동안 **내용은 제 폭으로 고정**해야 한다. 안 그러면 프레임마다
   * 내부가 다시 줄바꿈·자르기를 계산한다(히스토리 200줄이 그때마다 재배치된다). 전환이 끝나면
   * 고정을 풀어 평소처럼 폭에 맞춰 접히게 둔다(창이 좁을 때 내용이 잘리지 않게).
   *
   * 열릴 때는 접힌 폭으로 한 프레임 그린 뒤 뒤집어야 전환이 보인다.
   */
  const [expanded, setExpanded] = useState(false);
  // 첫 페인트부터 참이어야 한다 — 폭 0 에서 내용이 한 번 접혔다 펴지지 않게.
  const [moving, setMoving] = useState(true);

  useEffect(() => {
    let enterFrame = 0;
    let enterFrame2 = 0;
    let settle = 0;

    const startMotion = () => {
      // 이 시간 동안 터미널 fit 을 미루고, 끝나면 한 번만 돈다(layout-transition).
      // 전환보다 조금 길게 잡는다 — 딱 맞추면 폭이 마지막 몇 px 움직이는 중에 격자를 재고,
      // 그 뒤 프레임들이 보류에서 풀려 fit 이 몇 번 더 돈다.
      beginLayoutTransition(SESSION_PANEL_MOTION_MS + MOTION_SETTLE_MS);
      setMoving(true);
      settle = window.setTimeout(() => setMoving(false), SESSION_PANEL_MOTION_MS);
    };

    if (!open) {
      startMotion();
      setExpanded(false);
    } else {
      // **두 프레임**이 필요하다. 갓 붙은 노드에 한 프레임 뒤 폭을 바꾸면 브라우저가 첫 페인트
      // 전에 두 값을 합쳐 버려 전환이 아예 시작되지 않는다(그래서 열 때만 애니메이션이 없었다).
      enterFrame = requestAnimationFrame(() => {
        enterFrame2 = requestAnimationFrame(() => {
          startMotion();
          setExpanded(true);
        });
      });
    }

    return () => {
      cancelAnimationFrame(enterFrame);
      cancelAnimationFrame(enterFrame2);
      window.clearTimeout(settle);
    };
  }, [open]);

  const targetTab = tabs.find((tab) => tab.sessionId === sessionId);
  const blocks = useSessionCommandBlocks(sessionId ?? '');
  const shellHistory = useSessionShellHistory(sessionId ?? '');
  const sender = useSessionPanelSender(sessionId ?? '', blocks);
  // 지표는 발행 쪽 키로 읽는다 — tmux 는 창당 한 번만 폴링하며 첫 pane 키로 담는다.
  const metricsSessionId = useSessionPanelMetricsSessionId(sessionId ?? '');
  // 열었을 때 빈 레일만 보이면 "이게 뭐지" 가 된다. 처음 열면 히스토리를 보여 준다.
  // 고른 것이 없으면 세션 종류가 기본을 정한다(붙은 호스트는 자원, 로컬은 이력).
  const defaultSection = resolveDefaultSessionPanelSection(
    sessionId
      ? tabs.find((tab) => tab.sessionId === sessionId)?.source
      : null,
  );
  const section: SessionPanelSectionId = sessionId
    ? (sectionBySessionId[sessionId] ?? defaultSection)
    : defaultSection;
  // 도커를 부를 수 있는지는 **이 섹션을 열 때** 물어본다. 레일에 늘 있으니 미리 알 필요가 없고,
  // 다른 섹션을 보는 동안 왕복을 쓰지 않는다.
  const dockerRuntime = useDockerRuntime(
    open && sessionId && section === 'docker' ? sessionId : null,
    targetTab?.hostId ?? null,
  );
  const dockerBusy = useDockerBusy(sessionId);

  // 드래그를 끝내는 정리 함수. 언마운트에서도 불러야 한다 — 드래그 중에 세션이 끊겨 패널이
  // 사라지면(대상 세션이 null 이 되면 이 컴포넌트는 그냥 없어진다) mouseup 이 오기 전까지
  // 리스너가 남아 폭을 계속 바꾼다.
  const endResizeRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endResizeRef.current?.(), []);

  function handleResizeMouseDown(event: React.MouseEvent): void {
    dragRef.current = { startX: event.clientX, startWidth: width };
    const onMove = (moveEvent: MouseEvent) => {
      if (!dragRef.current) {
        return;
      }
      // 왼쪽 가장자리를 왼쪽으로 끌수록 넓어진다. 터미널은 flex 형제라 같이 좁아지고,
      // 리사이즈 스케줄러가 프레임당 한 번 fit 하며 격자가 실제로 바뀔 때만 PTY 에 보낸다.
      setWidth(dragRef.current.startWidth + (dragRef.current.startX - moveEvent.clientX));
    };
    const onUp = () => {
      dragRef.current = null;
      endResizeRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    endResizeRef.current = onUp;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    event.preventDefault();
  }

  if (!sessionId) {
    return null;
  }

  const totalWidth = width + RAIL_WIDTH_PX;

  return (
    <div
      className="relative flex min-h-0 min-w-0 overflow-hidden rounded-r-[10px] border-l border-[var(--border)] bg-[var(--surface)] transition-[width] ease-out motion-reduce:transition-none"
      style={{
        // 폭 자체가 움직인다 — 터미널이 같은 속도로 자리를 내주므로 패널과 뒤 화면이 따로
        // 놀지 않는다. 대신 그 사이 터미널은 예전 격자를 유지해 잘려 보이고(0.16초), 전환이
        // 끝난 뒤 한 번 맞춰진다.
        width: expanded ? totalWidth : 0,
        transitionDuration: `${SESSION_PANEL_MOTION_MS}ms`,
        // 줄어들 수 있어야 한다(0 1 auto). shrink-0 로 두면 창이 좁을 때 패널이 카드 밖으로
        // 밀려나 내용이 화면 밖에서 잘린다. maxWidth 로 터미널의 최소 몫도 함께 지킨다.
        flex: '0 1 auto',
        maxWidth: '70%',
      }}
    >
      {/* 전환 중에만 제 폭으로 고정한다(위 주석 참고). 끝나면 풀어 평소 레이아웃으로. */}
      <div
        className="flex min-h-0 min-w-0 flex-1"
        style={moving ? { width: totalWidth, flex: '0 0 auto' } : undefined}
      >
        <div
          className="absolute left-0 top-0 z-[2] h-full w-[6px] -translate-x-1/2 cursor-col-resize"
          onMouseDown={handleResizeMouseDown}
          aria-hidden
        />
        {/* 레일. 테두리를 주지 않는다 — 선이 늘면(패널 왼쪽 + 레일 오른쪽) 그것만으로 줄이 두 개
            보인다. 고른 섹션은 배경과 색으로만 드러낸다. */}
        <div
          className="flex shrink-0 flex-col items-center gap-1 py-2.5"
          style={{ width: RAIL_WIDTH_PX }}
        >
          {SECTIONS.map(({ id, Icon, labelKey }) => {
            const selected = section === id;
            return (
              <Tooltip key={id} label={translate(labelKey)}>
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={translate(labelKey)}
                  onClick={() => selectSection(sessionId, id)}
                  className={cn(
                    'grid h-[30px] w-[30px] place-items-center rounded-[9px] transition-colors',
                    selected
                      ? 'bg-[var(--selection-tint)] text-[var(--accent-strong)] shadow-[inset_0_0_0_1px_var(--selection-border)]'
                      : 'text-[var(--text-soft)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]',
                  )}
                >
                  <Icon className="h-[0.95rem] w-[0.95rem]" aria-hidden />
                </button>
              </Tooltip>
            );
          })}
        </div>
        {/* min-w-0 이 없으면 이 열의 최소 폭이 자식의 min-content 가 되어(줄바꿈 없는 명령
            한 줄) 패널이 그만큼 넓어지고 truncate 가 듣지 않는다. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1 px-2.5 pt-2.5">
            <span className="min-w-0 flex-1 truncate text-[0.8rem] font-semibold text-[var(--text)]">
              {translate(SECTION_TITLE_KEY[section])}
            </span>
            {/* 섹션 고유 동작은 이 자리에 붙인다 — 섹션이 자기 헤더를 또 만들면 줄이 두 개가 된다. */}
            {section === 'docker' ? (
              <Tooltip label={translate('sessionPanel.docker.refresh')}>
                <button
                  type="button"
                  aria-label={translate('sessionPanel.docker.refresh')}
                  onClick={() => sessionId && requestDockerRefresh(sessionId)}
                  className={HEADER_BUTTON_CLASS}
                >
                  <RefreshCw
                    className={cn('h-3.5 w-3.5', dockerBusy && 'animate-spin')}
                    aria-hidden
                  />
                </button>
              </Tooltip>
            ) : null}
            {section === 'ai' ? (
              <button
                type="button"
                className="shrink-0 rounded-[7px] px-1.5 py-0.5 text-[0.72rem] text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text)]"
                onClick={() => clearAiConversation(sessionId)}
              >
                {translate('aiChat.clear')}
              </button>
            ) : null}
            <Tooltip label={translate('sessionPanel.close')}>
              <button
                type="button"
                aria-label={translate('sessionPanel.close')}
                onClick={togglePanel}
                className={HEADER_BUTTON_CLASS}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
          </div>
          {section === 'history' ? (
            <SessionPanelHistory
              sessionId={sessionId}
              blocks={blocks}
              shellHistory={shellHistory}
              sender={sender}
            />
          ) : section === 'snippets' ? (
            <SessionPanelSnippets sessionId={sessionId} sender={sender} />
          ) : section === 'resources' ? (
            <SessionPanelResources
              sessionId={metricsSessionId}
              hostId={targetTab?.hostId ?? null}
              shellKind={targetTab?.shellKind ?? null}
              rttMs={targetTab?.lastRttMs ?? null}
            />
          ) : section === 'processes' ? (
            <SessionPanelProcesses sessionId={metricsSessionId} />
          ) : section === 'ports' ? (
            <SessionPanelPorts hostId={targetTab?.hostId ?? null} />
          ) : section === 'tmux' ? (
            <SessionPanelTmux sessionId={sessionId} />
          ) : section === 'docker' ? (
            <SessionPanelDocker
              sessionId={sessionId}
              hostId={targetTab?.hostId ?? null}
              sender={sender}
              runtime={dockerRuntime}
            />
          ) : section === 'theme' ? (
            <SessionPanelTheme hostId={targetTab?.hostId ?? null} />
          ) : (
            // 선택·최근 출력 캡처는 stableId 로 살아 있는 런타임에서 읽는다(재연결로 sessionId 가
            // 바뀌어도 안정).
            <AiChatPanel
              sessionId={sessionId}
              stableId={targetTab?.stableId ?? sessionId}
            />
          )}
        </div>
      </div>
    </div>
  );
}
