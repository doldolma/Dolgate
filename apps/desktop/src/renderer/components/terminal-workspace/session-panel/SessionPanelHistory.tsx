// 히스토리 섹션. 셸 통합이 이미 모아 둔 명령 블록을 그대로 읽는다 — 새로 수집하는 것은 없고,
// 범위는 "지금 연결된 이후"(레지스트리의 수명)다.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/cn';
import {
  buildHistoryItems,
  buildShellHistoryItems,
  limitListItems,
  filterByQuery,
  resolveHistoryActions,
  resolveSnippetActions,
  type SessionPanelHistoryItem,
} from '../../../lib/session-panel';
import { formatBlockDuration, formatBlockRelativeTime } from '../blockFormat';
import { ListFilter } from '../../../ui/icons';
import { Tooltip } from '../../../ui';
import { SessionPanelEmpty } from './SessionPanelEmpty';
import { SessionPanelRow } from './SessionPanelRow';
import { SessionPanelSearch } from './SessionPanelSearch';
import { useSessionScopedState } from '../../../lib/session-scoped-state';
import type { SessionPanelSender } from './useSessionPanelTarget';

interface SessionPanelHistoryProps {
  /** 검색어·필터를 세션마다 따로 기억하는 데 쓴다. */
  sessionId: string;
  blocks: readonly SessionPanelHistoryItem[];
  /**
   * 셸 히스토리 파일에서 온 이전 명령들(연결 시점 스냅샷).
   *
   * 이번 세션 목록과 **겹치지 않는다** — 스냅샷이 연결 시점에 떴으므로 이번에 친 명령이 들어
   * 있을 수 없다. 그래서 한 목록에 이어 붙이고 중복을 걱정하지 않는다.
   */
  shellHistory: readonly string[];
  sender: SessionPanelSender;
}

// 상태 점은 두지 않는다. 목록의 거의 모든 줄이 성공이라 줄마다 흐린 점이 하나씩 붙는 것이
// 전부였고, 정작 알아야 하는 실패는 오른쪽 `exit N` 딱지가 이미 색으로 말해 준다. 이전 명령의
// 빈 원은 "종료 코드가 없다" 는 뜻이었지만, 그 목록에는 애초에 종료 코드가 나온 적이 없다.

export function SessionPanelHistory({
  sessionId,
  blocks,
  shellHistory,
  sender,
}: SessionPanelHistoryProps) {
  const { t: translate } = useTranslation();
  // 검색어·필터는 세션마다 따로 기억한다 — 다른 서버로 옮기면 비고, 돌아오면 그대로 남는다.
  const [query, setQuery] = useSessionScopedState(sessionId, 'history.query', '');
  const [failedOnly, setFailedOnly] = useSessionScopedState(sessionId, 'history.failedOnly', false);
  // "몇 분 전" 이 렌더마다 흐르지 않게 목록이 바뀌는 시점으로 고정한다.
  const now = useMemo(() => Date.now(), [blocks]);

  const items = useMemo(() => {
    const ordered = buildHistoryItems(blocks).filter(
      (item) => !failedOnly || item.state === 'failed',
    );
    // 검색은 여기서 끝난다 — 원격에 아무것도 보내지 않는다.
    return filterByQuery(ordered, query, (item) => `${item.command ?? ''} ${item.cwd ?? ''}`);
  }, [blocks, failedOnly, query]);
  // 한 번에 그리는 줄 수를 묶는다 — 검색은 전체를 훑으므로 넘친 것도 검색으로 닿는다.
  const shownItems = useMemo(() => limitListItems(items), [items]);

  // 이전 명령들. 실패만 보기에는 해당하지 않는다 — 파일에는 종료 코드가 없다.
  const previous = useMemo(() => {
    if (failedOnly) {
      return [];
    }
    return filterByQuery(buildShellHistoryItems(shellHistory), query, (item) => item.command);
  }, [failedOnly, query, shellHistory]);
  const shownPrevious = useMemo(() => limitListItems(previous), [previous]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SessionPanelSearch
        value={query}
        onChange={setQuery}
        placeholder={translate('sessionPanel.history.search')}
        trailing={
          <Tooltip label={translate('sessionPanel.history.failedOnly')}>
            <button
              type="button"
              aria-pressed={failedOnly}
              aria-label={translate('sessionPanel.history.failedOnly')}
              onClick={() => setFailedOnly(!failedOnly)}
              className={cn(
                'grid h-9 w-9 shrink-0 place-items-center rounded-[9px] transition-colors',
                failedOnly
                  ? 'bg-[var(--danger-bg)] text-[var(--danger-text)]'
                  : 'text-[var(--text-soft)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]',
              )}
            >
              <ListFilter className="h-3.5 w-3.5" aria-hidden />
            </button>
          </Tooltip>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {items.length === 0 && previous.length === 0 ? (
          <SessionPanelEmpty
            title={
              query.trim() || failedOnly
                ? translate('sessionPanel.history.noMatchesTitle')
                : translate('sessionPanel.history.emptyTitle')
            }
            description={
              query.trim() || failedOnly
                ? translate('sessionPanel.history.noMatches')
                : translate('sessionPanel.history.empty')
            }
          />
        ) : (
          shownItems.shown.map((item) => {
            const actions = resolveHistoryActions(item, sender.context);
            const command = item.command ?? '';
            const failed = item.state === 'failed' && item.exitCode !== null;
            // 시각·소요는 오른쪽에 모아 줄마다 같은 자리에 오게 한다. 작업 디렉터리는 길이가
            // 제각각이라 왼쪽에서 잘리는 쪽이 낫다.
            const running = item.state === 'running';
            const timing = [
              running ? null : formatBlockRelativeTime(item.startedAt, now),
              formatBlockDuration(item.durationMs),
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <SessionPanelRow
                key={item.id}
                text={command}
                meta={item.cwd}
                metaTrailing={
                  <>
                    {/* 실패는 종료 코드를 딱지로 — 글자로만 적으면 훑을 때 눈에 걸리지 않는다. */}
                    {failed ? (
                      <span className="mr-1.5 rounded-[4px] bg-[var(--danger-bg)] px-1 py-px text-[0.64rem] font-medium text-[var(--danger-text)]">
                        exit {item.exitCode}
                      </span>
                    ) : null}
                    {/* 실행 중은 색으로 말한다 — 시각·소요와 같은 회색이면 훑을 때 안 걸린다. */}
                    {running ? (
                      <span className="mr-1.5 text-[var(--warning-text)]">
                        {translate('cmdPalette.running')}
                      </span>
                    ) : null}
                    {timing}
                  </>
                }
                actions={actions}
                blockedHint={
                  actions.blockedReason
                    ? translate(`sessionPanel.blocked.${actions.blockedReason}`)
                    : null
                }
                onCopy={() => sender.copy(command)}
                onInsert={() => sender.insert(command)}
                onRun={() => sender.run(command)}
                onActivate={
                  item.line >= 0 ? () => sender.jumpToLine(item.line) : undefined
                }
                activateLabel={translate('sessionPanel.history.jump')}
              />
            );
          })
        )}
        {shownItems.hidden > 0 ? (
          <p className="px-2.5 pt-1 text-[0.68rem] text-[var(--text-soft)]">
            {translate('sessionPanel.history.moreHidden', { count: shownItems.hidden })}
          </p>
        ) : null}
        {previous.length > 0 ? (
          <>
            {/* 경계를 실선으로 알려 준다 — 아래부터는 종료 코드도, 위치 이동도 없다. */}
            <div className="mt-2 flex items-baseline gap-2 border-t border-[var(--border)] px-2.5 pb-1 pt-2">
              <span className="text-[0.64rem] uppercase tracking-[0.1em] text-[var(--text-muted)]">
                {translate('sessionPanel.history.previous')}
              </span>
              <span className="tabular-nums text-[0.64rem] text-[var(--text-muted)]">
                {previous.length}
              </span>
            </div>
            {shownPrevious.shown.map((item) => (
              <SessionPanelRow
                key={item.key}
                text={item.command}
                dense
                // 몇 번 쳤는지. 접힌 줄이 몇 개였는지를 이 숫자가 대신한다.
                trailing={item.count > 1 ? `×${item.count}` : null}
                // 셸이 기록한 원문이라 화면에서 읽어 낸 것과 달리 보조 프롬프트가 섞이지
                // 않는다 — 스니펫과 같은 판정을 쓴다(여러 줄 줄은 애초에 Go 가 버린다).
                actions={resolveSnippetActions(item.command, sender.context)}
                blockedHint={null}
                onCopy={() => sender.copy(item.command)}
                onInsert={() => sender.insert(item.command)}
                onRun={() => sender.run(item.command)}
              />
            ))}
            {shownPrevious.hidden > 0 ? (
              <p className="px-2.5 pt-1 text-[0.68rem] text-[var(--text-soft)]">
                {translate('sessionPanel.history.moreHidden', {
                  count: shownPrevious.hidden,
                })}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
