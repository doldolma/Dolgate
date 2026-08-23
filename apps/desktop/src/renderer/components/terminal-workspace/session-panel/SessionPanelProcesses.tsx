// 프로세스 섹션. **모니터링만** 한다 — 종료·우선순위 변경은 넣지 않는다. 확인 절차와 권한 실패
// 안내가 필요해 패널의 성격(보기)에서 벗어나고, 조작이 필요하면 터미널에서 하는 편이 예측
// 가능하다.
//
// 수집은 자원 섹션과 같은 왕복에 태운다(ps 를 그 명령 묶음에 추가). 검색·정렬은 받아 온 상위
// N개를 앱에서 거르는 것이라 원격 왕복이 늘지 않는다.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/cn';
import { useAppStore } from '../../../store/appStore';
import { filterByQuery } from '../../../lib/session-panel';
import { formatKibibytes, type HostProcess } from '../../../lib/host-metrics';
import { Button } from '../../../ui';
import { SessionPanelEmpty } from './SessionPanelEmpty';
import { SessionPanelSearch } from './SessionPanelSearch';
import { useSessionHostMetrics } from './useSessionHostMetrics';

interface SessionPanelProcessesProps {
  sessionId: string;
}

type SortKey = 'cpu' | 'mem';

export function SessionPanelProcesses({ sessionId }: SessionPanelProcessesProps) {
  const { t: translate } = useTranslation();
  const enabled = useAppStore((state) => state.settings?.hostMetricsEnabled ?? false);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const { status, processes } = useSessionHostMetrics(sessionId, { processes: true });
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('cpu');

  const rows = useMemo(() => {
    if (!processes) {
      return [];
    }
    const sorted = [...processes].sort((left, right) =>
      sortKey === 'cpu'
        ? right.cpuPercent - left.cpuPercent
        : right.memPercent - left.memPercent,
    );
    return filterByQuery(
      sorted,
      query,
      (process) => `${process.command} ${process.user} ${process.pid}`,
    );
  }, [processes, query, sortKey]);

  if (!enabled) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        <SessionPanelEmpty
          title={translate('sessionPanel.resources.disabledTitle')}
          description={translate('sessionPanel.processes.disabled')}
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void updateSettings({ hostMetricsEnabled: true });
            }}
          >
            {translate('sessionPanel.resources.enable')}
          </Button>
        </SessionPanelEmpty>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SessionPanelSearch
        value={query}
        onChange={setQuery}
        placeholder={translate('sessionPanel.processes.search')}
        trailing={
          <div className="flex shrink-0 overflow-hidden rounded-[9px] bg-[var(--surface-strong)]">
            {(['cpu', 'mem'] as const).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={sortKey === key}
                onClick={() => setSortKey(key)}
                className={cn(
                  'px-2 py-1.5 text-[0.68rem] uppercase tracking-[0.06em] transition-colors',
                  sortKey === key
                    ? 'bg-[var(--selection-tint)] text-[var(--accent-strong)]'
                    : 'text-[var(--text-soft)] hover:text-[var(--text)]',
                )}
              >
                {translate(
                  key === 'cpu'
                    ? 'sessionPanel.processes.sortCpu'
                    : 'sessionPanel.processes.sortMem',
                )}
              </button>
            ))}
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {processes === null ? (
          <SessionPanelEmpty
            title={
              status === 'unsupported'
                ? translate('sessionPanel.resources.unsupportedTitle')
                : translate('sessionPanel.processes.loadingTitle')
            }
            description={
              status === 'unsupported'
                ? translate('sessionPanel.resources.unsupported')
                : translate('sessionPanel.processes.loading')
            }
          />
        ) : processes.length === 0 ? (
          // 명령은 돌았는데 한 줄도 없다 = busybox ps 처럼 옵션을 모르는 호스트다.
          <SessionPanelEmpty
            title={translate('sessionPanel.processes.unreadableTitle')}
            description={translate('sessionPanel.processes.unreadable')}
          />
        ) : rows.length === 0 ? (
          <SessionPanelEmpty
            title={translate('sessionPanel.history.noMatchesTitle')}
            description={translate('sessionPanel.processes.noMatches')}
          />
        ) : (
          rows.map((process) => <ProcessRow key={process.pid} process={process} />)
        )}
      </div>
    </div>
  );
}

function ProcessRow({ process }: { process: HostProcess }) {
  const { t: translate } = useTranslation();
  return (
    <div className="rounded-[9px] px-2.5 py-1.5 transition-colors hover:bg-[var(--surface-muted)]">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[0.78rem] text-[var(--text)]">
          {process.command}
        </span>
        <span className="shrink-0 tabular-nums text-[0.72rem] text-[var(--text)]">
          {process.cpuPercent.toFixed(1)}%
        </span>
      </div>
      <p className="truncate text-[0.7rem] text-[var(--text-soft)]">
        {translate('sessionPanel.processes.meta', {
          pid: process.pid,
          user: process.user,
          mem: process.memPercent.toFixed(1),
        })}
        {process.rssKb === null ? '' : ` · ${formatKibibytes(process.rssKb)}`}
      </p>
    </div>
  );
}
